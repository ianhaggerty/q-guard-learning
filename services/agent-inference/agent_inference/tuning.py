"""Players' own agents: copies of a pretrained checkpoint, fine-tuned live on the player's play.

While a player teaches their agent, the room server sends each 0.5 s of their manual play as
a demonstration: the observation at the start of the interval and the action they took, in
the training action space. A background thread trains each player's copy on its
demonstrations, mixing two losses by the player's blend a in [0, 1]:

  a     x DQfD large-margin loss (Hester et al. 2018), per action branch: the demonstrated
          action should score at least MARGIN above every other -> play like the player;
  1 - a x mean squared distance to the pretrained network's Q-values on the same states
          -> keep the pretrained agent's judgement, which was trained to score.

So a = 1 copies the player as closely as it can and a = 0 leaves the pretrained agent as it
was. Models belong to a session: they are dropped when the player resets them or leaves.
"""
import copy
import threading
import time
from collections import OrderedDict

import numpy as np
import torch
import torch.nn.functional as Fn

from guardrl.models import BRANCHES
from guardrl.obs import C_G, C_L, GG, L, N_V

#: DQfD margin: how far the demonstrated action should score above the others.
MARGIN = 0.8
LEARNING_RATE = 1e-4
BATCH = 32
#: Demonstrations kept per model, newest first out (about 17 minutes of teaching).
MAX_DEMOS = 2000
#: Training continues until each demonstration has had this many gradient steps' worth of use.
UPDATES_PER_DEMO = 1
#: Fewer demonstrations than this are not worth a gradient step yet.
MIN_DEMOS = 8


def greedy(net, loc, glo, vec, mask):
    """The branching network's best action per state, never an invalid move."""
    with torch.no_grad():
        q = net(torch.from_numpy(np.asarray(loc, np.float32)), torch.from_numpy(np.asarray(glo, np.float32)),
                torch.from_numpy(np.asarray(vec, np.float32)))
    move = q[0].numpy().copy()
    move[~mask] = -1e9
    return np.stack([move.argmax(1), q[1].numpy().argmax(1), q[2].numpy().argmax(1)], axis=1)


class TunedModel:
    """One player's agent for one plan: a trainable copy of `base` and its demonstrations."""

    def __init__(self, base):
        self.base = base                       # the pretrained network, never trained here
        self.net = copy.deepcopy(base)
        self.net.train()
        self.opt = torch.optim.Adam(self.net.parameters(), lr=LEARNING_RATE)
        self.loc = np.zeros((MAX_DEMOS, C_L, L, L), np.float16)
        self.glo = np.zeros((MAX_DEMOS, C_G, GG, GG), np.float16)
        self.vec = np.zeros((MAX_DEMOS, N_V), np.float32)
        self.mask = np.zeros((MAX_DEMOS, BRANCHES[0]), bool)
        self.act = np.zeros((MAX_DEMOS, 3), np.int64)
        self.stored = 0                        # demonstrations held (at most MAX_DEMOS)
        self.demos = 0                         # demonstrations ever received
        self.updates = 0
        self.blend = 0.5
        self.lock = threading.Lock()
        self.rng = np.random.default_rng(0)

    def add(self, loc, glo, vec, mask, action, blend):
        with self.lock:
            k = self.demos % MAX_DEMOS
            self.loc[k], self.glo[k], self.vec[k], self.mask[k], self.act[k] = loc, glo, vec, mask, action
            self.demos += 1
            self.stored = min(self.stored + 1, MAX_DEMOS)
            self.blend = float(np.clip(blend, 0.0, 1.0))

    @property
    def due(self):
        return self.stored >= MIN_DEMOS and self.updates < self.demos * UPDATES_PER_DEMO

    def train_step(self):
        with self.lock:
            idx = self.rng.integers(0, self.stored, BATCH)
            loc = torch.from_numpy(self.loc[idx].astype(np.float32))
            glo = torch.from_numpy(self.glo[idx].astype(np.float32))
            vec = torch.from_numpy(self.vec[idx])
            mask = torch.from_numpy(self.mask[idx])
            act = torch.from_numpy(self.act[idx])
            q = self.net(loc, glo, vec)
            with torch.no_grad():
                q_base = self.base(loc, glo, vec)
            # A player may walk into a wall, which the move mask calls invalid; their move still counts.
            valid = mask.scatter(1, act[:, :1], True)
            margin_loss, anchor_loss = 0.0, 0.0
            for d in range(3):
                scores = q[d] + MARGIN
                scores = scores.scatter(1, act[:, d:d + 1], q[d].gather(1, act[:, d:d + 1]))
                if d == 0:
                    scores = scores.masked_fill(~valid, -1e9)
                margin_loss = margin_loss + (scores.max(1).values - q[d].gather(1, act[:, d:d + 1]).squeeze(1)).mean()
                anchor_loss = anchor_loss + Fn.mse_loss(q[d], q_base[d])
            loss = (self.blend * margin_loss + (1 - self.blend) * anchor_loss) / 3
            self.opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(self.net.parameters(), 10.0)
            self.opt.step()
            self.updates += 1
            return float(loss)

    def decide(self, loc, glo, vec, mask):
        with self.lock:
            return greedy(self.net, loc, glo, vec, mask)

    def status(self):
        return {'demos': self.demos, 'updates': self.updates, 'blend': self.blend}


class TunedModels:
    """Every player's tuned models, keyed by (player, plan), with a training thread.

    At most `limit` models are kept (each, with its optimiser state and demonstrations, is
    about 56 MB); making one more drops the least recently used, whose player is back to the
    pretrained agent on that map.
    """

    def __init__(self, limit=32):
        self.limit = limit
        self.models = OrderedDict()
        self.lock = threading.Lock()
        self.thread = None
        self.stopping = threading.Event()

    def get(self, player, plan_id):
        with self.lock:
            model = self.models.get((player, plan_id))
            if model is not None:
                self.models.move_to_end((player, plan_id))
            return model

    def get_or_create(self, player, plan_id, base):
        with self.lock:
            key = (player, plan_id)
            if key not in self.models:
                self.models[key] = TunedModel(base)
                while len(self.models) > self.limit:
                    self.models.popitem(last=False)
            self.models.move_to_end(key)
            return self.models[key]

    def reset(self, player, plan_id):
        with self.lock:
            self.models.pop((player, plan_id), None)

    def forget(self, player):
        with self.lock:
            for key in [key for key in self.models if key[0] == player]:
                del self.models[key]

    def train_once(self):
        """One gradient step for every model that is due. Returns how many stepped."""
        with self.lock:
            due = [model for model in self.models.values() if model.due]
        for model in due:
            model.train_step()
        return len(due)

    def start(self):
        def loop():
            while not self.stopping.is_set():
                if not self.train_once():
                    time.sleep(0.05)
        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.stopping.set()
