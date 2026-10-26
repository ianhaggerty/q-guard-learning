"""Compile every numba kernel once so later processes load machine code from the cache.

Container images run this at build time with NUMBA_CACHE_DIR pointing inside the image and
NUMBA_CPU_NAME=generic, so the cached code runs on any node of the same architecture and pods
start without the JIT delay.  The plan should have stairs, chairs and doors; only argument
types matter to numba, but a realistic plan also exercises every Python wrapper.

usage: python -m guardrl.warmup <plan.json> [--heuristic]
"""
import argparse
import time

import numpy as np

from .plan import load_plan
from .env import GuardEnv
from .obs import ObsEncoder


def warmup(plan_path, heuristic=False):
    t0 = time.time()
    plan = load_plan(plan_path, use_cache=False, verbose=False)     # line-of-sight kernels
    env = GuardEnv(plan, n_envs=2, n_guards=2, field_slices=1)
    env.reset_env(0, starts=[plan.starts[g % len(plan.starts)] for g in range(env.G)])
    env.reset_env(0, random_pose=True)
    env.reset_env(1, warm_field=60.0, chair_start=1.0)
    enc = ObsEncoder(env)
    rng = np.random.default_rng(0)
    for _ in range(4):
        enc.encode()                                                 # block risk and move-mask kernels
        acts = np.zeros((env.E, env.G, 3), np.int64)
        acts[..., 0] = rng.integers(0, 10, (env.E, env.G))
        acts[..., 1] = rng.integers(0, 3, (env.E, env.G))
        acts[..., 2] = rng.integers(0, 8, (env.E, env.G))
        env.step(acts, abs_gaze=True)                                # movement, doors, chairs, field
    env.update_can_sit()
    if heuristic:                                                    # demonstrations (trainer only)
        from .heuristic import GreedyPatroller
        GreedyPatroller(env).actions()
    return time.time() - t0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('plan')
    ap.add_argument('--heuristic', action='store_true', help='also compile the demonstration heuristic')
    a = ap.parse_args()
    print(f'numba warm-up: {warmup(a.plan, a.heuristic):.1f} s')
