"""Logged-in players' agents outlive the process: their demonstrations are saved, the trainer
consolidates them, and new versions come back.

Players are named "user:<id>" (logged in) or "guest:<session>" (kept in memory only, as
before). For a user:
  * their live model starts from their published version for the plan, if they have one;
  * each demonstration is kept as a full transition (observation, action, the interval's
    detection credit and energy, and its place in an episode, which links it to the next) and
    saved in chunks of CHUNK_DEMOS (one minute of teaching), each a compressed .npz object
    with a row in demo_chunks; after every chunk, and when they stop teaching, the measured
    schedule (model_store.schedule) decides whether to queue a reward-driven training job;
  * a poller notices newly published versions every POLL_SECONDS and moves live models onto
    them, so a player's agent improves while they play.
"""
import threading
import time

import numpy as np

from model_store.schedule import maybe_enqueue
from model_store.serialize import demos_bytes, load_model

#: Demonstrations per saved chunk: one minute of teaching.
CHUNK_DEMOS = 120
POLL_SECONDS = 15


def user_of(player):
    """The user id behind a player name, or None for a guest."""
    return player[len('user:'):] if isinstance(player, str) and player.startswith('user:') else None


class Persistence:
    def __init__(self, store, objects, poll_seconds=POLL_SECONDS):
        self.store, self.objects, self.poll_seconds = store, objects, poll_seconds
        self.stopping = threading.Event()

    def published(self, user, plan_id):
        """(state dict, meta) of the user's published model for the plan, or None."""
        row = self.store.published(user, plan_id)
        if row is None:
            return None
        meta = {'version': row['version'], 'base_checkpoint': row['base_checkpoint'], 'guards': row['guards']}
        return load_model(self.objects.get(row['object_key'])), meta

    def record(self, model, user, plan_id, row, blend):
        """Keep one demonstration (a dict of DEMO_FIELDS values); save a chunk when one is full."""
        model.pending.append(row)
        if len(model.pending) >= CHUNK_DEMOS:
            self.flush(model, user, plan_id, blend)

    def flush(self, model, user, plan_id, blend, finished=False):
        """Save the model's pending demonstrations as a chunk, and queue training if it is due.
        Returns the queued job's id, if any."""
        rows, model.pending = model.pending, []
        if rows:
            demos = {field: np.array([row[field] for row in rows]) for field in rows[0]}
            key = f'demos/{user}/{plan_id}/{int(time.time() * 1000)}-{len(rows)}.npz'
            self.objects.put(key, demos_bytes(demos))
            self.store.add_chunk(user, plan_id, key, len(rows))
        meta = model.meta
        return maybe_enqueue(self.store, user, plan_id, model.blend, meta['base_checkpoint'], meta['guards'], finished=finished)

    def reset(self, user, plan_id):
        """Forget the user's agent for the plan, in storage too."""
        for key in self.store.reset(user, plan_id):
            try:
                self.objects.delete(key)
            except OSError:
                pass

    def status(self, user, plan_id):
        """What storage knows: the published version and its training report, and the latest job."""
        row = self.store.published(user, plan_id)
        job = self.store.last_job(user, plan_id)
        return {
            'version': row['version'] if row else 0,
            'trained': row['report'] if row else None,
            'job': {'status': job['status'], 'not_before': job['not_before'].isoformat()} if job else None,
        }

    def poll(self, tuned, net_from_state):
        """Move live models whose player has a newer published version onto it."""
        users = [(user_of(player), plan_id, model) for (player, plan_id), model in tuned.snapshot() if user_of(player)]
        if not users:
            return 0
        versions = self.store.versions([(user, plan_id) for user, plan_id, _ in users])
        moved = 0
        for user, plan_id, model in users:
            if versions.get((user, plan_id), 0) > model.meta.get('version', 0):
                found = self.published(user, plan_id)
                if found:
                    state, meta = found
                    model.replace(net_from_state(state), meta)
                    moved += 1
        return moved

    def start(self, tuned, net_from_state):
        def loop():
            while not self.stopping.wait(self.poll_seconds):
                try:
                    self.poll(tuned, net_from_state)
                except Exception as error:   # storage hiccups must not stop the poller
                    print(f'version poll failed: {error}', flush=True)
        threading.Thread(target=loop, daemon=True).start()
