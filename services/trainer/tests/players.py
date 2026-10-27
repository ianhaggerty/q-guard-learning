"""Simulated players for tests: demonstrations recorded the way the room server records them."""
import numpy as np

from guardrl.env import GuardEnv
from guardrl.evaluate import rel_to_abs
from guardrl.heuristic import GreedyPatroller
from guardrl.obs import ObsEncoder


def record_player(plan, guards, steps, gait=2, seed=3, episode=0):
    """`steps` decision intervals of guardrl's greedy patroller (sprinting by default) as demonstrations."""
    env = GuardEnv(plan, 1, guards, field_slices=1, seed=seed)
    encoder = ObsEncoder(env)
    env.reset_env(0, starts=[plan.starts[g % len(plan.starts)] for g in range(guards)])
    player = GreedyPatroller(env, gait=gait)
    rows = {k: [] for k in ('loc', 'glo', 'vec', 'mask', 'act', 'credit', 'kcal', 'episode', 'step')}
    for t in range(steps):
        loc, glo, vec, mask = encoder.encode()
        acts = rel_to_abs(player.actions(), env)
        kcal, credit, _ = env.step(acts, abs_gaze=True)
        for key, value in (('loc', loc[0].astype(np.float16)), ('glo', glo[0].astype(np.float16)), ('vec', vec[0]),
                           ('mask', mask[0]), ('act', acts[0, 0]), ('credit', credit[0, 0]), ('kcal', kcal[0, 0]),
                           ('episode', episode), ('step', t)):
            rows[key].append(value)
    return {key: np.array(values) for key, values in rows.items()}
