"""Guard-agent decisions for explorers in a room, with the pretrained checkpoints.

A room server sends the state of one room every 0.5 s: every explorer's pose (people and
agents alike, because agents see everyone as fellow guards), the probability field's
means, and which explorers the agent should drive. That state is copied into a GuardEnv
exactly as the training simulator holds it -- the JS core and guardrl order the field's
pixels, chairs and doors the same way, and doors are re-derived from positions with the
simulator's own rule -- so the observation is the one the network was trained on. Each
driven explorer gets (move 0-9, gait 0-2, absolute gaze 0-7), the training action space.

Checkpoints come from final_models/manifest.json: one per plan and team size. A room uses
the plan's checkpoint trained with the most guards not exceeding the explorers present.
They load with torch.load(weights_only=True), so a checkpoint cannot run code.
"""
import base64
import json
import os
import re
import threading

import numpy as np
import torch

from guardrl import sim
from guardrl.dqn import Agent
from guardrl.env import GuardEnv
from guardrl.obs import ObsEncoder
from guardrl.plan import load_plan

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DEFAULT_PLANS_DIR = os.path.join(REPO, 'apps', 'web', 'plans')
DEFAULT_MODELS_DIR = os.path.join(REPO, 'artifacts', 'final_models')

PLAN_FILE = re.compile(r'^(\d+)\.\s*(.+)\.json$')


def load_checkpoint(path):
    sd = torch.load(path, map_location='cpu', weights_only=True)
    agent = Agent(head=sd['head'], noisy=sd['noisy'], n_nets=len(sd['nets']))
    agent.load_nets(sd)
    for net in agent.nets:
        net.set_noise(False)
        net.eval()
    return agent


class Policies:
    """Plans, checkpoints and per-team-size environments, loaded on first use and kept."""

    def __init__(self, plans_dir=None, models_dir=None):
        plans_dir = plans_dir or DEFAULT_PLANS_DIR
        models_dir = models_dir or DEFAULT_MODELS_DIR
        self.plan_paths = {}
        for name in os.listdir(plans_dir):
            match = PLAN_FILE.match(name)
            if match:
                self.plan_paths[match.group(1)] = os.path.join(plans_dir, name)
        by_file = {os.path.basename(path): plan_id for plan_id, path in self.plan_paths.items()}
        manifest = json.load(open(os.path.join(models_dir, 'manifest.json')))
        self.checkpoints = {}  # plan id -> {guards: checkpoint path}
        for entry in manifest.values():
            plan_id = by_file.get(os.path.basename(entry['plan']))
            if plan_id is not None:
                self.checkpoints.setdefault(plan_id, {})[entry['guards']] = os.path.join(models_dir, entry['checkpoint'])
        self.plans, self.agents, self.envs = {}, {}, {}
        self.lock = threading.Lock()

    def plan(self, plan_id):
        if plan_id not in self.plans:
            if plan_id not in self.plan_paths:
                raise KeyError(f'unknown plan {plan_id!r}')
            self.plans[plan_id] = load_plan(self.plan_paths[plan_id], verbose=False)
        return self.plans[plan_id]

    def checkpoint_for(self, plan_id, explorers):
        """The plan's checkpoint trained with the most guards not exceeding `explorers` (else the fewest)."""
        options = self.checkpoints.get(plan_id)
        if not options:
            raise KeyError(f'no checkpoint for plan {plan_id!r}')
        fitting = [guards for guards in options if guards <= explorers]
        return options[max(fitting) if fitting else min(options)]

    def agent(self, path):
        if path not in self.agents:
            self.agents[path] = load_checkpoint(path)
        return self.agents[path]

    def env(self, plan_id, guards):
        key = (plan_id, guards)
        if key not in self.envs:
            env = GuardEnv(self.plan(plan_id), 1, guards, field_slices=1)
            self.envs[key] = (env, ObsEncoder(env))
        return self.envs[key]

    def preload(self):
        """Load every plan (computing its line-of-sight cache) and checkpoint, and warm up each one."""
        for plan_id in sorted(self.plan_paths, key=int):
            if plan_id not in self.checkpoints:
                continue
            plan = self.plan(plan_id)
            start = plan.starts[0]
            for guards in self.checkpoints[plan_id]:
                state = [{'x': start['x'], 'y': start['y'], 'floor': start['floor'], 'heading': 0, 'look': 0,
                          'gait': 0, 'sitting': False, 'seat': -1}] * guards
                means = base64.b64encode(np.zeros(len(plan.cand_w), np.float32).tobytes()).decode()
                self.act({'plan': plan_id, 'explorers': state, 'agents': [0], 'means': means})

    def act(self, request):
        """Actions [[move, gait, gaze], ...] for request['agents'] (indices into request['explorers'])."""
        with self.lock:
            plan_id, explorers, agents = str(request['plan']), request['explorers'], request['agents']
            guards = len(explorers)
            if not guards or not agents or any(not 0 <= k < guards for k in agents):
                raise ValueError('agents must index the explorers')
            plan = self.plan(plan_id)
            means = np.frombuffer(base64.b64decode(request['means']), np.float32)
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
            loc, glo, vec, mask = encoder.encode()
            chosen = np.asarray(agents, np.int64)
            agent = self.agent(self.checkpoint_for(plan_id, guards))
            actions = agent.greedy(loc[chosen], glo[chosen], vec[chosen], mask[chosen], np.zeros(len(chosen), np.int64))
            return actions.tolist()
