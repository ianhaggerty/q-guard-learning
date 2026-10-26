"""Training loop for the deep Q-learning guards.

Reward for guard g over one decision interval (dt = 0.5 s):
    'reduction' (default, per guard):  r_g = w_R * D_g - kcal_g
        D_g = detection reduction of sum P credited to g (hazard-proportional split)
    'level' (single-guard alternative): r = -w_L * sum P * dt - kcal
With discount gamma the two are policy-equivalent for one guard when w_R = w_L * dt / (1 - gamma)
(potential-based shaping with Phi = -sum P; see report).  Rewards are divided by a plan-specific
scale (expected arrivals per step x w_R) so Q-values are O(10) on every plan.

Several plans can be trained at once ('plans'): all environments switch to a random plan of the
list at every (synchronised) episode boundary -- used for curriculum / domain-randomised
pre-training.
"""
import argparse
import json
import os
import time

import numpy as np
import numba
import torch

from .plan import load_plan, EVENT_RATE
from .env import GuardEnv
from .obs import ObsEncoder
from .dqn import Agent, Replay, NStep
from .evaluate import rollout, agent_policy, rel_to_abs
from .heuristic import GreedyPatroller


def default_config():
    return dict(
        plan='plans/2. Simple Centre.json', plans=None, eval_plans=None, n_guards=1, n_envs=32, dt=0.5,
        field_slices=5,
        steps=400_000,                 # transitions (env steps x n_envs x n_guards)
        episode_seconds=600, warm_field=600, random_starts=True, chair_start=0.0,
        reward='reduction', w_level=0.3,     # w_L kcal per (expected event x second)
        w_level_start=None, w_anneal_frac=0.5,   # optional reward-weight curriculum (geometric anneal of w_L)
        head='branch', noisy=False, prioritized=False, double=True, gamma=0.99, nstep=3,
        lr=1e-4, batch=128, buffer=300_000, learn_start=10_000, updates_per_train=1,
        target_tau=0.005, eps_start=1.0, eps_end=0.03, eps_decay_frac=0.4, ez=True,
        init=None, init_mapping=None, n_nets=1, net_of_guard=None, freeze_nets=None,
        demo_steps=0, demo_pretrain_updates=0, demo_weight=1.0, demo_frac=0.25, demo_heuristic=None,
        eval_every=50_000, eval_seconds=900, seed=0, out='runs/test', threads=8, numba_threads=8,
    )


def reward_scale(w_level, cfg, plan):
    w_R = w_level * cfg['dt'] / (1 - cfg['gamma'])
    arrivals_per_step = EVENT_RATE * plan.cand_w.sum() * cfg['dt']
    return w_R, w_R * arrivals_per_step


class Ctx:
    """One plan with its environment batch, encoder and (lazily) a demonstrator."""

    def __init__(self, path, cfg, seed):
        self.plan = load_plan(path, verbose=False)
        self.env = GuardEnv(self.plan, cfg['n_envs'], cfg['n_guards'], dt=cfg['dt'], field_slices=cfg['field_slices'],
                            seed=seed)
        self.enc = ObsEncoder(self.env)
        self.demo = None


def train(cfg):
    torch.set_num_threads(cfg['threads'])
    numba.set_num_threads(cfg['numba_threads'])
    os.makedirs(cfg['out'], exist_ok=True)
    json.dump(cfg, open(os.path.join(cfg['out'], 'config.json'), 'w'), indent=1)
    rng = np.random.default_rng(cfg['seed'])
    plan_list = cfg['plans'] or [cfg['plan']]
    multi = len(plan_list) > 1
    ctxs = {}

    def ctx(i):
        if i not in ctxs:
            ctxs[i] = Ctx(plan_list[i], cfg, cfg['seed'] + 17 * i)
        return ctxs[i]

    eval_paths = cfg['eval_plans'] or [plan_list[0]]
    eval_plans = [load_plan(p, verbose=False) for p in eval_paths]
    G, E = cfg['n_guards'], cfg['n_envs']
    agent = Agent(head=cfg['head'], noisy=cfg['noisy'], n_nets=cfg['n_nets'], lr=cfg['lr'], gamma=cfg['gamma'],
                  nstep=cfg['nstep'], batch=cfg['batch'], target_tau=cfg['target_tau'],
                  prioritized=cfg['prioritized'], double=cfg['double'], seed=cfg['seed'],
                  demo_weight=cfg['demo_weight'])
    if cfg['init']:
        sd = torch.load(cfg['init'], weights_only=False)
        agent.load_nets(sd, cfg['init_mapping'])
    net_of_guard = np.array(cfg['net_of_guard'] if cfg['net_of_guard'] is not None else [0] * G)
    frozen = set(cfg['freeze_nets'] or [])
    rb = Replay(cfg['buffer'], seed=cfg['seed'])
    rb_demo = Replay(cfg['demo_steps'] + 2048, seed=cfg['seed'] + 1) if cfg['demo_steps'] > 0 else None
    log = []
    ep_len = int(cfg['episode_seconds'] / cfg['dt'])

    def reset(c, e):
        starts = None if cfg['random_starts'] else [c.plan.starts[g % len(c.plan.starts)] for g in range(G)]
        c.env.reset_env(e, starts=starts, warm_field=cfg['warm_field'], random_pose=True, chair_start=cfg['chair_start'])

    cur = ctx(0)
    for e in range(E):
        reset(cur, e)
    t_in_ep = np.zeros(E, np.int64) if multi else rng.integers(0, ep_len, E)
    nsteps = [[NStep(cfg['nstep'], cfg['gamma']) for _ in range(G)] for _ in range(E)]
    obs = cur.enc.encode()
    total, t0 = 0, time.time()
    ep_ret = np.zeros((E, G))
    recent, loss_hist = [], []
    next_eval = cfg['eval_every']
    demo_left = cfg['demo_steps']
    while total < cfg['steps']:
        env, enc, plan = cur.env, cur.enc, cur.plan
        frac = min(1.0, total / max(1, cfg['eps_decay_frac'] * cfg['steps']))
        eps = cfg['eps_start'] + (cfg['eps_end'] - cfg['eps_start']) * frac
        w_cur = cfg['w_level']
        if cfg['w_level_start'] is not None:
            wf = min(1.0, total / max(1, cfg['w_anneal_frac'] * cfg['steps']))
            w_cur = cfg['w_level_start'] * (cfg['w_level'] / cfg['w_level_start']) ** wf
        w_R, rscale = reward_scale(w_cur, cfg, plan)
        loc, glo, vec, can = obs
        nets_flat = np.tile(net_of_guard, E)
        is_demo = demo_left > 0
        if is_demo:
            if cur.demo is None:
                cur.demo = GreedyPatroller(env, **(cfg['demo_heuristic'] or {}))
            acts = rel_to_abs(cur.demo.actions(), env).reshape(E * G, 3)
        else:
            acts = agent.act(loc, glo, vec, can, 0.0 if cfg['noisy'] else eps, nets_flat, ez=cfg['ez'],
                             heading=env.heading.reshape(-1))
        kcal, credit, psum = env.step(acts.reshape(E, G, 3), abs_gaze=True)
        if cfg['reward'] == 'reduction':
            r = (w_R * credit - kcal) / rscale
        else:
            r = (-w_cur * psum[:, None] * cfg['dt'] / G - kcal) / rscale
        ep_ret += r
        t_in_ep += 1
        nobs = enc.encode()
        nloc, nglo, nvec, ncan = nobs
        done = t_in_ep >= ep_len
        for e in range(E):
            for g in range(G):
                i = e * G + g
                ns = nsteps[e][g]
                ns.push((loc[i], glo[i], vec[i]), acts[i], float(r[e, g]))
                for (s, a, ret, disc, s2, nc) in ns.pop_ready((nloc[i], nglo[i], nvec[i]), ncan[i], flush=bool(done[e])):
                    if net_of_guard[g] in frozen:
                        continue
                    (rb_demo if is_demo else rb).add(s, a, ret, disc, s2, nc, net=int(net_of_guard[g]), demo=is_demo)
        total += E * G
        if done.any():
            for e in np.nonzero(done)[0]:
                recent.append(ep_ret[e].mean())
                ep_ret[e] = 0
                t_in_ep[e] = 0
            if multi:
                cur = ctx(int(rng.integers(len(plan_list))))
                for e in range(E):
                    reset(cur, e)
            else:
                for e in np.nonzero(done)[0]:
                    reset(cur, e)
            nobs = cur.enc.encode()
        obs = nobs
        if is_demo:
            demo_left -= E * G
            if demo_left <= 0 and cfg['demo_pretrain_updates'] > 0:
                for k in range(cfg['demo_pretrain_updates']):
                    for kk in range(cfg['n_nets']):
                        if kk not in frozen:
                            agent.update(rb, kk, rb_demo=rb_demo, demo_frac=1.0)
        if rb.n >= cfg['learn_start'] and not is_demo:
            for _ in range(cfg['updates_per_train']):
                for kk in range(cfg['n_nets']):
                    if kk not in frozen:
                        l, q = agent.update(rb, kk, beta=0.4 + 0.6 * frac, rb_demo=rb_demo, demo_frac=cfg['demo_frac'])
                        loss_hist.append((l, q))
        if total >= next_eval or total >= cfg['steps']:
            next_eval += cfg['eval_every']
            ms = []
            for ep in eval_plans:
                res = rollout(ep, agent_policy(agent, net_of_guard), G, seconds=cfg['eval_seconds'], field_slices=5)
                ms.append(res['metrics'])
            m = {k: float(np.mean([x[k] for x in ms])) for k in ms[0] if isinstance(ms[0][k], float)}
            mfrac = {k: float(np.mean([x['frac'][k] for x in ms])) for k in ms[0]['frac']}
            lh = np.array(loss_hist[-500:]) if loss_hist else np.zeros((1, 2))
            entry = dict(steps=total, time=time.time() - t0, eps=eps, w_level=w_cur,
                         ep_return=float(np.mean(recent[-50:])) if recent else None,
                         loss=float(lh[:, 0].mean()), q=float(lh[:, 1].mean()), **m,
                         **{'frac_' + k: v for k, v in mfrac.items()},
                         cost=cfg['w_level'] * m['mean_psum'] + m['team_kcal_per_hour'] / 3600,
                         per_plan=[dict(plan=os.path.basename(p), mean_psum=x['mean_psum'],
                                        kcal_per_hour=x['team_kcal_per_hour']) for p, x in zip(eval_paths, ms)])
            log.append(entry)
            print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in entry.items() if k != 'per_plan'}),
                  flush=True)
            json.dump(log, open(os.path.join(cfg['out'], 'log.json'), 'w'), indent=1)
            torch.save(agent.state_dict(), os.path.join(cfg['out'], 'model.pt'))
            if entry['cost'] <= min(x['cost'] for x in log):
                torch.save(agent.state_dict(), os.path.join(cfg['out'], 'best.pt'))
    return agent, log


def config_from_args(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', type=str, default=None, help='JSON file with overrides')
    ap.add_argument('--set', nargs='*', default=[], help='key=value overrides (JSON values)')
    args = ap.parse_args(argv)
    cfg = default_config()
    if args.config:
        cfg.update(json.load(open(args.config)))
    for kv in args.set:
        k, v = kv.split('=', 1)
        try:
            cfg[k] = json.loads(v)
        except json.JSONDecodeError:
            cfg[k] = v
    return cfg


def main():
    train(config_from_args())


if __name__ == '__main__':
    main()
