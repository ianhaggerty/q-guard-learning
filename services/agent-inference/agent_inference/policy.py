"""Guard-agent decisions for explorers in a room, with the pretrained checkpoints.

A room server sends the state of one room every 0.5 s: every explorer's pose (people and
agents alike, because agents see everyone as fellow guards), the probability field's
means, and which explorers the agent should drive. That state is copied into a GuardEnv
exactly as the training simulator holds it -- the JS core and guardrl order the field's
pixels, chairs and doors the same way, and doors are re-derived from positions with the
simulator's own rule -- so the observation is the one the network was trained on. Each
driven explorer gets (move 0-9, gait 0-2, absolute gaze 0-7), the training action space.

Checkpoints come from final_models/manifest.json (see model_store.catalog): one per plan and
team size. A room uses the plan's checkpoint trained with the most guards not exceeding the
explorers present. They load with weights_only=True, so a checkpoint cannot run code.

A player can also teach their own agent (see tuning.py): demonstrate() adds a moment of
their play to their copy of the plan's checkpoint, and from then on act() drives that
player's explorer with their copy instead of the pretrained one. With persistence (see
persistence.py), logged-in players' agents and demonstrations are kept and trained further.
"""
import base64
import threading
import time

import numpy as np

from guardrl import sim
from guardrl.dqn import Agent
from guardrl.env import GuardEnv
from guardrl.obs import ObsEncoder
from model_store.catalog import Catalog

from .persistence import user_of
from .tuning import TunedModels, greedy

#: How long to remember that a user has no published model for a plan before asking again.
UNPUBLISHED_SECONDS = 15


def agent_from_state(state):
    agent = Agent(head=state['head'], noisy=state['noisy'], n_nets=len(state['nets']))
    agent.load_nets(state)
    for net in agent.nets:
        net.set_noise(False)
        net.eval()
    return agent


class Policies:
    """Plans, checkpoints, per-team-size environments and players' agents, loaded on first use."""

    def __init__(self, plans_dir=None, models_dir=None, persistence=None, tuned_limit=32):
        self.catalog = Catalog(plans_dir, models_dir)
        self.persistence = persistence
        self.agents, self.envs = {}, {}
        self.lock = threading.Lock()
        self.tuned = TunedModels(tuned_limit, on_evict=self.save_evicted)
        self.unpublished = {}  # (player, plan id) -> when storage last said "no published model"

    @property
    def checkpoints(self):
        return self.catalog.checkpoints

    def plan(self, plan_id):
        return self.catalog.plan(plan_id)

    def checkpoint_for(self, plan_id, explorers):
        return self.catalog.checkpoint_for(plan_id, explorers)

    def agent(self, name):
        if name not in self.agents:
            self.agents[name] = agent_from_state(self.catalog.load_checkpoint(name))
        return self.agents[name]

    def env(self, plan_id, guards):
        key = (plan_id, guards)
        if key not in self.envs:
            env = GuardEnv(self.plan(plan_id), 1, guards, field_slices=1)
            self.envs[key] = (env, ObsEncoder(env))
        return self.envs[key]

    def preload(self):
        """Load every plan (computing its line-of-sight cache) and checkpoint, and warm up each one."""
        for plan_id in sorted(self.catalog.plan_paths, key=int):
            if plan_id not in self.checkpoints:
                continue
            plan = self.plan(plan_id)
            start = plan.starts[0]
            for guards in self.checkpoints[plan_id]:
                state = [{'x': start['x'], 'y': start['y'], 'floor': start['floor'], 'heading': 0, 'look': 0,
                          'gait': 0, 'sitting': False, 'seat': -1}] * guards
                means = base64.b64encode(np.zeros(len(plan.cand_w), np.float32).tobytes()).decode()
                self.act({'plan': plan_id, 'explorers': state, 'agents': [0], 'means': means})

    def observe(self, plan_id, explorers, means_base64):
        """Observations (loc, glo, vec, mask) for every explorer of a room. Hold self.lock."""
        guards = len(explorers)
        if not guards:
            raise ValueError('a room needs at least one explorer')
        plan = self.plan(plan_id)
        means = np.frombuffer(base64.b64decode(means_base64), np.float32)
        if means.shape[0] != len(plan.cand_w):
            raise ValueError(f'expected {len(plan.cand_w)} field means, got {means.shape[0]}')
        env, encoder = self.env(plan_id, guards)
        for g, explorer in enumerate(explorers):
            heading, look = int(explorer['heading']) % 8, int(explorer['look']) % 8
            env.pos[0, g] = (float(explorer['x']), float(explorer['y']))
            env.fl[0, g] = int(explorer['floor'])
            env.heading[0, g], env.look[0, g], env.facing[0, g] = heading, look, (heading + look) % 8
            env.gait[0, g] = int(explorer['gait'])
            env.sitting[0, g] = bool(explorer['sitting'])
            env.seat[0, g] = int(explorer['seat'])
        env.means[0] = means
        env.psum[0] = sim.prob_sum(env.means[0])
        sim.update_doors(env.door_floor, plan.door_cells_ptr, env.door_cells, env.door_bbox, env.door_open[0],
                         env.pos[0], env.fl[0], guards)
        return encoder.encode()

    # ------------------------------------------------------------------ players' agents

    def model_for(self, player, plan_id, explorers=None):
        """The player's live model for the plan, loading their published one if they are a
        logged-in user with one. With `explorers` (a demonstration), create one from the
        pretrained checkpoint for that team size if there is none yet; otherwise None means
        the pretrained agent drives."""
        model = self.tuned.get(player, plan_id)
        if model is not None:
            return model
        user = user_of(player)
        recently_absent = time.monotonic() - self.unpublished.get((player, plan_id), -1e9) < UNPUBLISHED_SECONDS
        if user and self.persistence and not recently_absent:
            found = self.persistence.published(user, plan_id)
            if found:
                state, meta = found
                return self.tuned.get_or_create(player, plan_id, agent_from_state(state).nets[0], meta)
            self.unpublished[(player, plan_id)] = time.monotonic()
        if explorers is None:
            return None
        name, guards = self.checkpoint_for(plan_id, len(explorers))
        meta = {'version': 0, 'base_checkpoint': name, 'guards': guards}
        return self.tuned.get_or_create(player, plan_id, self.agent(name).nets[0], meta)

    def save_evicted(self, player, plan_id, model):
        user = user_of(player)
        if user and self.persistence and model.pending:
            self.persistence.flush(model, user, plan_id, model.blend, finished=True)

    def act(self, request):
        """Actions [[move, gait, gaze], ...] for request['agents'] (indices into request['explorers']).

        request['owners'], if given, names the player behind each driven explorer: a player
        with their own model for this plan is driven by it.
        """
        plan_id, explorers, agents = str(request['plan']), request['explorers'], request['agents']
        owners = request.get('owners') or [None] * len(agents)
        if not agents or len(owners) != len(agents) or any(not 0 <= k < len(explorers) for k in agents):
            raise ValueError('agents must index the explorers, with one owner each')
        models = [self.model_for(owner, plan_id) if owner is not None else None for owner in owners]
        with self.lock:
            loc, glo, vec, mask = self.observe(plan_id, explorers, request['means'])
            base = self.agent(self.checkpoint_for(plan_id, len(explorers))[0]).nets[0]
            actions = []
            for k, model in zip(agents, models):
                one = (loc[k:k + 1], glo[k:k + 1], vec[k:k + 1], mask[k:k + 1])
                actions.append((model.decide(*one) if model else greedy(base, *one))[0].tolist())
            return actions

    def demonstrate(self, request):
        """Teach request['player']'s agent for this plan one demonstrated action. Returns its status.

        request: plan, player, blend (0 = stay pretrained ... 1 = copy the player), action
        [move, gait, gaze], and the room state at the start of the action (explorers, means)
        with `agent` the index of the player's explorer; for kept agents also credit and kcal
        (the interval's detection credit and energy) and episode and step (which link it to
        the next demonstration).
        """
        plan_id, explorers, k = str(request['plan']), request['explorers'], int(request['agent'])
        move, gait, gaze = (int(value) for value in request['action'])
        if not (0 <= k < len(explorers) and 0 <= move < 10 and 0 <= gait < 3 and 0 <= gaze < 8):
            raise ValueError('agent must index the explorers, and the action must be in the action space')
        player, blend = str(request['player']), float(request.get('blend', 0.5))
        model = self.model_for(player, plan_id, explorers)
        with self.lock:
            loc, glo, vec, mask = self.observe(plan_id, explorers, request['means'])
        model.add(loc[k], glo[k], vec[k], mask[k], (move, gait, gaze), blend)
        user = user_of(player)
        if user and self.persistence:
            row = {'loc': loc[k].astype(np.float16), 'glo': glo[k].astype(np.float16), 'vec': vec[k], 'mask': mask[k],
                   'act': np.array([move, gait, gaze]), 'credit': float(request['credit']), 'kcal': float(request['kcal']),
                   'episode': int(request['episode']), 'step': int(request['step'])}
            self.persistence.record(model, user, plan_id, row, blend)
        return model.status()

    def flush(self, player, plan_id):
        """The player stopped teaching: save what is pending and maybe queue training."""
        user, model = user_of(player), self.tuned.get(player, plan_id)
        if user and self.persistence and model:
            self.persistence.flush(model, user, plan_id, model.blend, finished=True)

    def reset(self, player, plan_id):
        self.tuned.reset(player, plan_id)
        self.unpublished.pop((player, plan_id), None)
        user = user_of(player)
        if user and self.persistence:
            self.persistence.reset(user, plan_id)

    def forget(self, player):
        """The player has gone: drop their live models, saving a user's pending demonstrations."""
        for (_, plan_id), model in self.tuned.forget(player):
            self.save_evicted(player, plan_id, model)

    def status(self, player, plan_id):
        model = self.tuned.get(player, plan_id)
        status = model.status() if model else {'demos': 0, 'updates': 0, 'blend': None, 'version': 0}
        user = user_of(player)
        if user and self.persistence:
            status.update(self.persistence.status(user, plan_id))
        return status

    def start(self):
        """Start the background work: live training, and following published versions."""
        self.tuned.start()
        if self.persistence:
            self.persistence.start(self.tuned, lambda state: agent_from_state(state).nets[0])
