"""One fine-tuning job: reward-driven learning for a player's agent on one plan.

The live tuning in the agent service only imitates. A job here consolidates: it starts from
the player's current model and runs deep Q-learning from demonstrations (DQfD, Hester et
al. 2018) with guardrl's own learner --
  * the player's demonstrations are full transitions (observation, action, the interval's
    detection credit and energy, the next observation), kept in a permanent demonstration
    buffer; each update draws `demo_frac` of its batch from them and adds the large-margin
    loss, weighted `demo_weight`, on those samples;
  * the agent also plays the plan in the simulator, as in training (random starts, a warm
    field, teammates driven by the same agent), and learns from the reward
    r = (w_R x credit - kcal) / scale, exactly as guardrl.train rewards it.
The player's blend a sets the mix: demo_frac = 0.1 + 0.8a and demo_weight = 2a, so a = 0
improves the agent purely on reward and a = 1 mostly copies the player.

The job evaluates the model before and after on the same seeded episodes and reports the
change in cost (w_level x mean expected unspotted events + kcal per second, lower is better)
and in agreement with the player's demonstrated actions; the caller decides whether to
publish (see accept()).

Settings, from measurements (two minutes of a simulated player who always sprints, on Simple
Centre with one guard and Alcatraz with two; 400 vector steps of 8 environments):
  * learning rate 1e-5: at 5e-5 even pure reward learning (a = 0) made the pretrained agent
    23 % worse in one job -- a short job's small, fresh replay destabilises a network that is
    already near its optimum -- while at 1e-5 it stays within 4 %;
  * no demonstration-only pre-training: it pushed cost up 2.5-3.5x for a few points of
    agreement;
  * at a = 0.5 agreement with the player rose from 2 % to 81 % (91 % on Alcatraz), at a
    cost +30 % that mostly reflects this player's sprinting; at a = 0.1, 33 % agreement at
    unchanged cost (80 % at +5 % on Alcatraz);
  * a job takes about 50 s on 2 threads (Simple Centre) and 80 s on 4 (Alcatraz, two
    guards); 4 threads were slower than 2 on the small plan.
"""
import time

import numpy as np
import torch

from guardrl.dqn import Agent, NStep, Replay
from guardrl.env import GuardEnv
from guardrl.evaluate import agent_policy, cost, rollout
from guardrl.obs import ObsEncoder
from guardrl.train import default_config, reward_scale

CFG = default_config()
W_LEVEL = CFG['w_level']
DT, GAMMA, NSTEP = CFG['dt'], CFG['gamma'], CFG['nstep']


def blend_settings(blend):
    """demo_frac and demo_weight for a blend in [0, 1] (0: play to score ... 1: copy the player)."""
    blend = float(np.clip(blend, 0.0, 1.0))
    return 0.1 + 0.8 * blend, 2.0 * blend


def demo_transitions(demos, plan, cap_extra=0):
    """The player's demonstrations as an n-step Replay flagged demo=True.

    demos: dict of arrays over N demonstrations -- loc, glo, vec, mask (valid moves), act,
    credit, kcal (over the interval), episode and step (consecutive steps of one episode
    link each demonstration to the next). The last step of an episode has no next
    observation and contributes no transition.
    """
    w_R, scale = reward_scale(W_LEVEL, CFG, plan)
    order = np.lexsort((demos['step'], demos['episode']))
    n = len(order)
    rb = Replay(max(1, n + cap_extra), seed=1)
    for position, i in enumerate(order):
        ret, discount, j = 0.0, 1.0, i
        nxt = None
        for k in range(NSTEP):
            ret += discount * (w_R * float(demos['credit'][j]) - float(demos['kcal'][j])) / scale
            discount *= GAMMA
            later = position + k + 1
            if later >= n:
                break
            candidate = order[later]
            if demos['episode'][candidate] != demos['episode'][i] or demos['step'][candidate] != demos['step'][i] + k + 1:
                break
            nxt, j = candidate, candidate
        if nxt is None:
            continue
        rb.add((demos['loc'][i], demos['glo'][i], demos['vec'][i]), demos['act'][i], ret, discount,
               (demos['loc'][nxt], demos['glo'][nxt], demos['vec'][nxt]), demos['mask'][nxt], demo=True)
    return rb


def agreement(agent, demos):
    """Share of demonstrations whose move and gaze the agent would choose too."""
    if not len(demos['act']):
        return None
    chosen = agent.greedy(demos['loc'].astype(np.float32), demos['glo'].astype(np.float32), demos['vec'],
                          demos['mask'], np.zeros(len(demos['act']), np.int64))
    same = (chosen[:, 0] == demos['act'][:, 0]) & (chosen[:, 2] == demos['act'][:, 2])
    return float(same.mean())


def evaluate(agent, plan, guards, seconds, seed):
    """Cost on seeded episodes with a warm field (the same episodes for every model)."""
    result = rollout(plan, agent_policy(agent, [0] * guards), guards, seconds=seconds, field_slices=5,
                     warm_field=600, seed=seed, n_envs=2, record=False)
    return float(cost(result['metrics'], W_LEVEL))


def accept(report, blend):
    """Publish a job's model? Always when the player asked mostly to be copied; otherwise only if
    it did not get more than 5 % worse at the game."""
    if blend >= 0.5:
        return True
    return report['cost_after'] <= report['cost_before'] * 1.05


def load(state_dict):
    agent = Agent(head=state_dict['head'], noisy=state_dict['noisy'], n_nets=len(state_dict['nets']))
    agent.load_nets(state_dict)
    return agent


def finetune(plan, base_state, guards, demos, blend, env_steps=400, updates_per_step=2, n_envs=8,
             pretrain_updates=0, eval_seconds=120, seed=0, lr=1e-5):
    """Fine-tune `base_state` (an Agent.state_dict()) on `plan`. Returns (new state dict, report).

    env_steps vector steps of n_envs simulated environments (0.5 s each), with
    updates_per_step gradient steps after each once the buffer has filled a little, after
    pretrain_updates demonstration-only steps (DQfD pre-training).
    """
    started = time.time()
    demo_frac, demo_weight = blend_settings(blend)
    agent = Agent(head=base_state['head'], noisy=base_state['noisy'], n_nets=1, lr=lr, gamma=GAMMA, nstep=NSTEP,
                  batch=64, seed=seed, demo_weight=demo_weight)
    agent.load_nets(base_state)
    before = load(base_state)
    report = {'demos': int(len(demos['act'])), 'blend': float(blend), 'guards': guards,
              'agreement_before': agreement(before, demos),
              'cost_before': evaluate(before, plan, guards, eval_seconds, seed)}

    rb_demo = demo_transitions(demos, plan) if len(demos['act']) else None
    if rb_demo is not None and rb_demo.n == 0:
        rb_demo = None
    rb = Replay(env_steps * n_envs * guards + 1, seed=seed)
    updates = 0
    if rb_demo is not None and blend > 0:
        for _ in range(pretrain_updates):
            agent.update(rb, rb_demo=rb_demo, demo_frac=1.0)
            updates += 1

    env = GuardEnv(plan, n_envs, guards, dt=DT, field_slices=5, seed=seed)
    encoder = ObsEncoder(env)
    for e in range(n_envs):
        env.reset_env(e, warm_field=600, random_pose=True)
    w_R, scale = reward_scale(W_LEVEL, CFG, plan)
    streams = [[NStep(NSTEP, GAMMA) for _ in range(guards)] for _ in range(n_envs)]
    learn_start = min(1000, env_steps * n_envs * guards // 4)
    obs = encoder.encode()
    for _ in range(env_steps):
        loc, glo, vec, can = obs
        acts = agent.act(loc, glo, vec, can, 0.05, np.zeros(len(loc), np.int64), heading=env.heading.reshape(-1))
        kcal, credit, _ = env.step(acts.reshape(n_envs, guards, 3), abs_gaze=True)
        reward = (w_R * credit - kcal) / scale
        nobs = encoder.encode()
        nloc, nglo, nvec, ncan = nobs
        for e in range(n_envs):
            for g in range(guards):
                i = e * guards + g
                stream = streams[e][g]
                stream.push((loc[i], glo[i], vec[i]), acts[i], float(reward[e, g]))
                for s, a, ret, disc, s2, nc in stream.pop_ready((nloc[i], nglo[i], nvec[i]), ncan[i]):
                    rb.add(s, a, ret, disc, s2, nc)
        obs = nobs
        if rb.n >= learn_start:
            for _ in range(updates_per_step):
                agent.update(rb, rb_demo=rb_demo, demo_frac=demo_frac if rb_demo is not None else 0.0)
                updates += 1

    for net in agent.nets:
        net.eval()
    report.update(agreement_after=agreement(agent, demos), cost_after=evaluate(agent, plan, guards, eval_seconds, seed),
                  env_steps=env_steps * n_envs * guards, updates=updates, seconds=round(time.time() - started, 1))
    return agent.state_dict(), report
