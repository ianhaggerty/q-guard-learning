"""Training worker: takes reward-driven fine-tuning jobs from the queue and publishes the results.

Any number of workers can run, on any number of machines: each claims the oldest due job
(FOR UPDATE SKIP LOCKED, so no two share one), renews its lease while it works, and gives the
job back if it fails. A job whose worker dies is claimed again once the lease runs out. The
queue is the only coordination, so adding capacity is adding workers (Kubernetes scales them
on the number of due jobs; see deploy/k8s/base/trainer.yaml).

A job fine-tunes the user's published model for one plan (or, the first time, the pretrained
checkpoint the job names) on their most recent demonstrations (see finetune.py), and
publishes the result as the next version if accept() approves. A reset while the job ran, or
a newer version, wins: the job's model is then discarded.

Environment: DATABASE_URL, OBJECT_STORE_URL, PLANS_DIR and MODELS_DIR, CPU_LIMIT (threads),
WORKER_NAME (default: host name and process id).

usage: python -m trainer.worker [--once]
"""
import argparse
import os
import socket
import threading
import time
import traceback

from model_store.catalog import Catalog
from model_store.objects import open_objects
from model_store.serialize import concat_demos, load_demos, load_model, model_bytes
from model_store.store import Store

from .finetune import accept, finetune

LEASE_SECONDS = 300
RENEW_SECONDS = 60
IDLE_SECONDS = 5
#: A job trains on at most this many of the user's newest demonstrations (about 33 minutes).
MAX_DEMOS = 4000
#: The job size measured in finetune.py's notes: about a minute on two threads.
JOB_SETTINGS = dict(env_steps=400, n_envs=8, updates_per_step=2, pretrain_updates=0, eval_seconds=120, lr=1e-5)


class Lease:
    """Renews a job's lease in the background; `lost` is set if the job stops being ours."""

    def __init__(self, store, job_id, worker):
        self.store, self.job_id, self.worker = store, job_id, worker
        self.lost, self.done = threading.Event(), threading.Event()
        self.thread = threading.Thread(target=self.keep, daemon=True)

    def keep(self):
        while not self.done.wait(RENEW_SECONDS):
            if not self.store.renew(self.job_id, self.worker, LEASE_SECONDS):
                self.lost.set()
                return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.done.set()


def run_job(job, store, objects, catalog, worker, settings=None):
    """Train and maybe publish for one claimed job. Returns the job's result record."""
    settings = {**JOB_SETTINGS, **(settings or {})}
    user, plan_id = str(job['user_id']), job['plan_id']
    plan = catalog.plan(plan_id)
    published = store.published(user, plan_id)
    if published:
        base = load_model(objects.get(published['object_key']))
        base_checkpoint, guards, version = published['base_checkpoint'], published['guards'], published['version']
    else:
        base_checkpoint, guards, version = job['base_checkpoint'], job['guards'], 0
        base = catalog.load_checkpoint(base_checkpoint)
    chunks = store.chunks(user, plan_id, MAX_DEMOS)
    demos = concat_demos([load_demos(objects.get(chunk['object_key'])) for chunk in chunks])
    last_chunk = chunks[-1]['id'] if chunks else store.trained_through(user, plan_id)

    state, report = finetune(plan, base, guards, demos, job['blend'], seed=int(job['id']), **settings)
    result = {**report, 'from_version': version, 'accepted': accept(report, job['blend']), 'published': False}
    if result['accepted']:
        key = f'models/{user}/{plan_id}/v{version + 1}-job{job["id"]}.pt'
        objects.put(key, model_bytes(state))
        result['published'] = store.publish(user, plan_id, version, key, base_checkpoint, guards, report['demos'], report)
        if not result['published']:
            objects.delete(key)
    return result, last_chunk


def work(store, objects, catalog, worker, once=False, settings=None):
    """Claim and run jobs until stopped (or until the queue is empty, with once)."""
    while True:
        job = store.claim(worker, LEASE_SECONDS)
        if job is None:
            if once:
                return
            time.sleep(IDLE_SECONDS)
            continue
        with Lease(store, job['id'], worker) as lease:
            try:
                result, last_chunk = run_job(job, store, objects, catalog, worker, settings)
            except Exception as error:
                traceback.print_exc()
                store.fail(job['id'], worker, f'{type(error).__name__}: {error}')
                continue
            if lease.lost.is_set():
                continue
            store.finish(job['id'], worker, result, last_chunk)
        print(f'job {job["id"]} ({job["plan_id"]}): accepted={result["accepted"]} published={result["published"]} '
              f'cost {result["cost_before"]:.4f} -> {result["cost_after"]:.4f}, '
              f'agreement {result["agreement_before"]} -> {result["agreement_after"]}, {result["seconds"]} s', flush=True)


def main():
    from .__main__ import cpu_budget
    threads = cpu_budget()
    os.environ.setdefault('NUMBA_NUM_THREADS', str(threads))
    import torch
    torch.set_num_threads(threads)
    parser = argparse.ArgumentParser(description='Run reward-driven fine-tuning jobs from the queue.')
    parser.add_argument('--once', action='store_true', help='stop when no job is due')
    args = parser.parse_args()
    worker = os.environ.get('WORKER_NAME') or f'{socket.gethostname()}:{os.getpid()}'
    print(f'trainer worker {worker}: {threads} threads', flush=True)
    work(Store(os.environ['DATABASE_URL']), open_objects(), Catalog(), worker, once=args.once)


if __name__ == '__main__':
    main()
