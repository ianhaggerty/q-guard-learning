"""Roll-outs and metrics."""
import numpy as np

from .env import GuardEnv
from .obs import ObsEncoder
from . import sim

STEADY_FROM = 1 / 3      # steady-state metrics are averaged over the last 2/3 of the roll-out


def rollout(plan, policy, n_guards=1, seconds=1800, dt=0.5, field_slices=1, starts=None, warm_field=None,
            record=True, seed=0, n_envs=1, snap=None):
    """policy(env, enc, t) -> actions (E, G, 3).  Starts default to the plan's numbered starts."""
    env = GuardEnv(plan, n_envs, n_guards, dt=dt, field_slices=field_slices, seed=seed)
    enc = ObsEncoder(env)
    if starts is None:
        st = plan.starts
        starts = [st[g % len(st)] for g in range(n_guards)]
    for e in range(n_envs):
        env.reset_env(e, starts=starts, warm_field=warm_field)
    T = int(round(seconds / dt))
    G = n_guards
    traj = np.zeros((T, n_envs, G, 8), np.float32)    # x, y, floor, heading, facing, gait, sitting, look
    psum = np.zeros((T, n_envs))
    kcal = np.zeros((T, n_envs, G))
    credit = np.zeros((T, n_envs, G))
    acts_log = np.zeros((T, n_envs, G, 3), np.int16)
    floor_sums = np.zeros((T, n_envs, plan.F))
    cfp = env.cand_floor_ptr
    snaps = []
    for t in range(T):
        a = policy(env, enc, t)
        k, c, ps = env.step(a, abs_gaze=getattr(policy, 'abs_gaze', False))
        psum[t] = ps
        kcal[t] = k
        credit[t] = c
        acts_log[t] = a
        traj[t, :, :, 0:2] = env.pos
        traj[t, :, :, 2] = env.fl
        traj[t, :, :, 3] = env.heading
        traj[t, :, :, 4] = env.facing
        traj[t, :, :, 5] = env.gait
        traj[t, :, :, 6] = env.sitting
        traj[t, :, :, 7] = env.look
        if snap is not None:
            ts = (t + 1) * dt
            if snap[0] <= ts < snap[1] and abs((ts - snap[0]) / snap[2] - round((ts - snap[0]) / snap[2])) < 1e-6:
                snaps.append(env.means[0].copy())
        if plan.F > 1:
            P = -np.expm1(-env.means)
            for f in range(plan.F):
                floor_sums[t, :, f] = P[:, cfp[f]:cfp[f + 1]].sum(1)
    out = dict(psum=psum, kcal=kcal, credit=credit, traj=traj, acts=acts_log, act_secs=env.act_secs.copy(),
               dt=dt, floor_sums=floor_sums, final_means=env.means.copy())
    if snaps:
        sm = np.array(snaps)
        P = -np.expm1(-sm)
        out['means_snaps'] = dict(means=sm, t0=snap[0], every=snap[2], vmax=float(np.percentile(P[P > 0], 99)))
    out['metrics'] = metrics(out, plan)
    return out


def metrics(r, plan):
    psum, kcal, dt = r['psum'], r['kcal'], r['dt']
    T = psum.shape[0]
    t0 = int(T * STEADY_FROM)
    act = r['act_secs'][..., :14].copy()             # (E, G, 14)
    blocked = r['act_secs'][..., 14]
    act[..., 1] -= blocked                           # voluntary standing only
    act = np.concatenate([act, blocked[..., None]], -1)
    tot = act.sum(-1, keepdims=True)
    frac = act / np.maximum(tot, 1e-9)
    names = sim.ACTIVITY_NAMES
    groups = {
        'sitting': [0], 'standing': [1], 'walking': [5, 8, 9], 'running': [6, 10, 11], 'sprinting': [7, 12, 13],
        'backward': [2, 3, 4], 'blocked': [14],
    }
    g = {k: float(frac[..., v].sum(-1).mean()) for k, v in groups.items()}
    traj = r['traj']
    look = traj[..., 7]
    moving = r['acts'][..., 0]
    mv = (moving >= 1) & (moving <= 8)
    head = traj[..., 3]
    turns = (np.abs(((head[1:] - head[:-1] + 4) % 8) - 4))
    reversals = float(((turns == 4) & mv[1:] & mv[:-1]).mean())
    lm = look[mv]
    look_fwd = float((lm == 0).mean()) if lm.size else 0.0
    look_side = float(((lm == 1) | (lm == 7) | (lm == 2) | (lm == 6)).mean()) if lm.size else 0.0
    m = dict(
        mean_psum=float(psum[t0:].mean()), final_psum=float(psum[-1].mean()), max_psum=float(psum[t0:].max()),
        kcal_per_hour=float(kcal.sum(0).mean() / (T * dt) * 3600),
        kcal_per_hour_per_guard=float(kcal.sum(0).mean() / (T * dt) * 3600),
        team_kcal_per_hour=float(kcal.sum(0).sum(-1).mean() / (T * dt) * 3600),
        detected_P=float(r['credit'].sum(0).sum(-1).mean()),
        frac=g, look_forward=look_fwd, look_side=look_side, reversal_rate=reversals,
        distance_m=None,
    )
    return m


def cost(m, w_level):
    """Average cost per second: w_level * mean sum P + team kcal per second (lower is better)."""
    return w_level * m['mean_psum'] + m['team_kcal_per_hour'] / 3600.0


# ---------------------------------------------------------------- baseline policies
def stand_policy(look=0):
    def pol(env, enc, t):
        a = np.zeros((env.E, env.G, 3), np.int64)
        a[..., 2] = look
        return a
    return pol


def spin_policy(period=4):
    """Stand still and sweep the gaze through the eight directions."""
    def pol(env, enc, t):
        a = np.zeros((env.E, env.G, 3), np.int64)
        a[..., 2] = (t // period) % 8
        return a
    return pol


def random_policy(seed=0):
    rng = np.random.default_rng(seed)

    def pol(env, enc, t):
        a = np.zeros((env.E, env.G, 3), np.int64)
        a[..., 0] = rng.integers(0, 10, (env.E, env.G))
        a[..., 1] = rng.integers(0, 3, (env.E, env.G))
        a[..., 2] = rng.integers(0, 8, (env.E, env.G))
        return a
    return pol


def heuristic_policy(env_holder={}):
    from .heuristic import GreedyPatroller

    def pol(env, enc, t):
        if env_holder.get('env') is not env:
            env_holder['env'] = env
            env_holder['h'] = GreedyPatroller(env)
        return env_holder['h'].actions()
    return pol


def agent_policy(agent, net_of_guard=None, eps=0.0):
    def pol(env, enc, t):
        loc, glo, vec, can = enc.encode()
        N = loc.shape[0]
        nets = np.zeros(N, np.int64)
        if net_of_guard is not None:
            nets = np.tile(np.asarray(net_of_guard), env.E)
        if eps > 0:
            a = agent.act(loc, glo, vec, can, eps, nets, ez=False, heading=env.heading.reshape(-1))
        else:
            a = agent.greedy(loc, glo, vec, can, nets)
        return a.reshape(env.E, env.G, 3)
    pol.abs_gaze = True
    return pol


def rel_to_abs(acts, env):
    """Convert (move, gait, relative look) actions to (move, gait, absolute gaze)."""
    a = acts.copy()
    mv = a[..., 0]
    h = np.where((mv >= 1) & (mv <= 8), mv - 1, env.heading)
    a[..., 2] = (h + a[..., 2]) % 8
    return a
