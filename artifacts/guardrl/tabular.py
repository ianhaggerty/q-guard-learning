"""Tabular Q-learning baselines (Watkins Q-learning and Double Q-learning, n-step).

State  : (floor, block x, block y, heading, sitting) -- the guard's own pose only.  The
         probability field is NOT part of the state, so the learned greedy policy is a fixed
         route (a patrol loop or a fixed post).
Actions: move (stay, 8 headings, sit) x gait (walk, run); look is fixed forward.
"""
import json
import os
import time

import numpy as np
import numba

from .plan import load_plan, EVENT_RATE
from .env import GuardEnv
from .evaluate import rollout

N_MOVE, N_GAIT = 10, 2
N_A = N_MOVE * N_GAIT


N_FEAT = 9 * 3     # (direction of the risk 'centre of pull': 8 + none) x (total risk level: 3)


def field_feature(env):
    """Hand-engineered summary of the probability field for the tabular agent: the direction of
    the risk-weighted pull sum_b risk_b (b - x)/|b - x|^2 (8 headings, or 'none' if weak), and a
    3-level bucket of total sum P relative to 60 s of arrivals."""
    p = env.plan
    risk = env.block_risk()                                     # (E, F, Hb, Wb)
    E, G = env.E, env.G
    ys, xs = np.mgrid[0:p.Hb, 0:p.Wb]
    cx, cy = xs * 3 + 1.5, ys * 3 + 1.5
    lam60 = env.rate * p.cand_w.sum() * 60
    out = np.zeros((E, G), np.int64)
    for e in range(E):
        tot = risk[e].sum()
        lvl = 0 if tot < 0.5 * lam60 else (1 if tot < 1.5 * lam60 else 2)
        for g in range(G):
            f = env.fl[e, g]
            dx, dy = cx - env.pos[e, g, 0], cy - env.pos[e, g, 1]
            d2 = dx * dx + dy * dy + 9.0
            r = risk[e, f]
            vx, vy = (r * dx / d2).sum(), (r * dy / d2).sum()
            if np.hypot(vx, vy) < 1e-12 or tot <= 0:
                k = 8
            else:
                k = int(round(np.arctan2(vy, vx) / (np.pi / 4))) % 8
            out[e, g] = k * 3 + lvl
    return out


def state_index(env, Wb, Hb, features=False):
    bx = np.clip((env.pos[..., 0] // 3).astype(np.int64), 0, Wb - 1)
    by = np.clip((env.pos[..., 1] // 3).astype(np.int64), 0, Hb - 1)
    s = ((((env.fl * Hb + by) * Wb + bx) * 8 + env.heading) * 2 + env.sitting.astype(np.int64))
    if features:
        s = s * N_FEAT + field_feature(env)
    return s


def decode(a):
    return a // N_GAIT, a % N_GAIT


def train_tabular(plan_path, steps=1_000_000, n_envs=32, w_level=0.3, gamma=0.99, alpha=0.1, nstep=3,
                  double=False, optimistic=0.0, eps_start=1.0, eps_end=0.03, eps_decay_frac=0.5,
                  episode_seconds=600, warm_field=600, seed=0, eval_every=200_000, out=None, field_slices=5,
                  features=False):
    plan = load_plan(plan_path, verbose=False)
    env = GuardEnv(plan, n_envs, 1, field_slices=field_slices, seed=seed)
    rng = np.random.default_rng(seed)
    S = plan.F * plan.Hb * plan.Wb * 8 * 2 * (N_FEAT if features else 1)
    Q = [np.full((S, N_A), optimistic, np.float64) for _ in range(2 if double else 1)]
    dt = env.dt
    w_R = w_level * dt / (1 - gamma)
    rscale = w_R * EVENT_RATE * plan.cand_w.sum() * dt
    ep_len = int(episode_seconds / dt)
    for e in range(n_envs):
        env.reset_env(e, warm_field=warm_field, random_pose=True)
    t_ep = rng.integers(0, ep_len, n_envs)
    hist_s = [[] for _ in range(n_envs)]
    hist_a = [[] for _ in range(n_envs)]
    hist_r = [[] for _ in range(n_envs)]
    total, log, t0, next_eval = 0, [], time.time(), eval_every
    opt_left = np.zeros(n_envs, np.int64)
    opt_a = np.zeros(n_envs, np.int64)

    def qsum(s):
        return Q[0][s] + (Q[1][s] if double else 0)

    while total < steps:
        frac = min(1, total / (eps_decay_frac * steps))
        eps = eps_start + (eps_end - eps_start) * frac
        s = state_index(env, plan.Wb, plan.Hb, features)[:, 0]
        mask = env.update_masks()[:, 0].astype(bool)            # (E, 10)
        can = mask[:, 9]
        q = qsum(s).copy()
        q[np.repeat(~mask, N_GAIT, axis=1)] = -1e9
        a = q.argmax(1)
        for e in range(n_envs):
            if opt_left[e] > 0 and mask[e, opt_a[e] // N_GAIT]:
                a[e] = opt_a[e]
                opt_left[e] -= 1
            elif rng.random() < eps:
                valid = np.nonzero(np.repeat(mask[e], N_GAIT))[0]
                a[e] = valid[rng.integers(len(valid))]
                opt_a[e] = a[e]
                opt_left[e] = min(16, rng.zipf(2.0)) - 1
        mv, gait = decode(a)
        if np.any((mv == 9) & (can == 0)):
            mv = np.where((mv == 9) & (can == 0), 0, mv)
        acts = np.stack([mv, gait, np.zeros_like(mv)], -1)[:, None, :]
        kcal, credit, psum = env.step(acts)
        r = (w_R * credit[:, 0] - kcal[:, 0]) / rscale
        s2 = state_index(env, plan.Wb, plan.Hb, features)[:, 0]
        t_ep += 1
        for e in range(n_envs):
            hist_s[e].append(s[e]); hist_a[e].append(a[e]); hist_r[e].append(r[e])
            flush = t_ep[e] >= ep_len
            while len(hist_s[e]) >= nstep or (flush and hist_s[e]):
                k = min(nstep, len(hist_s[e]))
                G = sum(hist_r[e][i] * gamma ** i for i in range(k))
                i_upd = rng.integers(2) if double else 0
                Qa = Q[i_upd]
                Qb = Q[1 - i_upd] if double else Q[0]
                astar = Qa[s2[e]].argmax()
                target = G + gamma ** k * Qb[s2[e], astar]
                s0, a0 = hist_s[e][0], hist_a[e][0]
                Qa[s0, a0] += alpha * (target - Qa[s0, a0])
                hist_s[e].pop(0); hist_a[e].pop(0); hist_r[e].pop(0)
                if not flush:
                    break
            if flush:
                env.reset_env(e, warm_field=warm_field, random_pose=True)
                t_ep[e] = 0
        total += n_envs
        if total >= next_eval or total >= steps:
            next_eval += eval_every
            res = rollout(plan, tabular_policy(Q, plan, double, features), 1, seconds=900, field_slices=5)
            m = res['metrics']
            entry = dict(steps=total, time=time.time() - t0, eps=eps, **{k: v for k, v in m.items() if k != 'frac'},
                         **{'frac_' + k: v for k, v in m['frac'].items()},
                         cost=w_level * m['mean_psum'] + m['team_kcal_per_hour'] / 3600, visited=int((Q[0] != optimistic).any(1).sum()))
            log.append(entry)
            print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in entry.items()}), flush=True)
            if out:
                os.makedirs(out, exist_ok=True)
                json.dump(log, open(os.path.join(out, 'log.json'), 'w'), indent=1)
                np.savez_compressed(os.path.join(out, 'q.npz'), *Q)
    return Q, log


def tabular_policy(Q, plan, double=False, features=False):
    def pol(env, enc, t):
        s = state_index(env, plan.Wb, plan.Hb, features)
        mask = env.update_masks().astype(bool)
        q = Q[0][s] + (Q[1][s] if double else 0)
        q = q.copy()
        q[np.repeat(~mask, N_GAIT, axis=-1)] = -1e9
        a = q.argmax(-1)
        mv, gait = decode(a)
        return np.stack([mv, gait, np.zeros_like(mv)], -1)
    return pol


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', default='plans/2. Simple Centre.json')
    ap.add_argument('--steps', type=int, default=1_000_000)
    ap.add_argument('--w_level', type=float, default=0.3)
    ap.add_argument('--double', action='store_true')
    ap.add_argument('--optimistic', type=float, default=0.0)
    ap.add_argument('--out', default='runs/tab')
    ap.add_argument('--numba_threads', type=int, default=4)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--features', action='store_true')
    a = ap.parse_args()
    numba.set_num_threads(a.numba_threads)
    train_tabular(a.plan, steps=a.steps, w_level=a.w_level, double=a.double, optimistic=a.optimistic, out=a.out,
                  seed=a.seed, features=a.features)
