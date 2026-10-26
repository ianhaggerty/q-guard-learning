"""Fine-tuning job entry point: guardrl.train, sized to the pod's CPU allowance.

Numba and torch size their thread pools from the host's core count, not the container's CPU
limit, so a pod limited to 4 cores on a 64-core node would start 64 threads per pool and be
throttled.  The simulator and the gradient steps alternate rather than overlap, so both pools
get the whole allowance; the `threads` and `numba_threads` settings of a supplied config are
replaced, because they describe the machine the config was written on.

usage: python -m trainer [--config file.json] [--set key=value ...]   (as guardrl.train)
"""
import math
import os


def cpu_budget():
    """Whole cores this container may use: CPU_LIMIT (Kubernetes downward API), else the cgroup v2
    quota, else every core."""
    if os.environ.get('CPU_LIMIT'):
        return max(1, int(os.environ['CPU_LIMIT']))
    try:
        quota, period = open('/sys/fs/cgroup/cpu.max').read().split()
        if quota != 'max':
            return max(1, math.ceil(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    return os.cpu_count() or 1


def main():
    n = cpu_budget()
    os.environ['NUMBA_NUM_THREADS'] = str(n)     # read once, when numba is first imported
    os.environ['OMP_NUM_THREADS'] = str(n)
    from guardrl.train import config_from_args, train
    cfg = config_from_args()
    cfg.update(threads=n, numba_threads=n)
    print(f'trainer: {n} CPU threads for torch and numba')
    train(cfg)


if __name__ == '__main__':
    main()
