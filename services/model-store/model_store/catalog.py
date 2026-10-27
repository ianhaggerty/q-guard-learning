"""The plans rooms run on and the pretrained checkpoints for them.

Plans are the numbered files in PLANS_DIR ("3. Two Chair Square.json" is plan "3"); the
checkpoints are listed in MODELS_DIR/manifest.json, one per plan and team size. Both default
to the repository's apps/web/plans and artifacts/final_models.
"""
import json
import os
import re
import threading

import torch

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PLAN_FILE = re.compile(r'^(\d+)\.\s*(.+)\.json$')


class Catalog:
    def __init__(self, plans_dir=None, models_dir=None):
        self.plans_dir = plans_dir or os.environ.get('PLANS_DIR') or os.path.join(REPO, 'apps', 'web', 'plans')
        self.models_dir = models_dir or os.environ.get('MODELS_DIR') or os.path.join(REPO, 'artifacts', 'final_models')
        self.plan_paths = {}
        for name in os.listdir(self.plans_dir):
            match = PLAN_FILE.match(name)
            if match:
                self.plan_paths[match.group(1)] = os.path.join(self.plans_dir, name)
        by_file = {os.path.basename(path): plan_id for plan_id, path in self.plan_paths.items()}
        with open(os.path.join(self.models_dir, 'manifest.json')) as file:
            manifest = json.load(file)
        self.checkpoints = {}  # plan id -> {guards: checkpoint file name}
        for entry in manifest.values():
            plan_id = by_file.get(os.path.basename(entry['plan']))
            if plan_id is not None:
                self.checkpoints.setdefault(plan_id, {})[entry['guards']] = entry['checkpoint']
        self.plans = {}
        self.lock = threading.Lock()

    def plan(self, plan_id):
        """The loaded guardrl plan (computing its line-of-sight cache the first time)."""
        from guardrl.plan import load_plan
        with self.lock:
            if plan_id not in self.plans:
                if plan_id not in self.plan_paths:
                    raise KeyError(f'unknown plan {plan_id!r}')
                self.plans[plan_id] = load_plan(self.plan_paths[plan_id], verbose=False)
            return self.plans[plan_id]

    def checkpoint_for(self, plan_id, explorers):
        """(file name, guards) of the plan's checkpoint trained with the most guards not
        exceeding `explorers` (else the fewest)."""
        options = self.checkpoints.get(plan_id)
        if not options:
            raise KeyError(f'no checkpoint for plan {plan_id!r}')
        fitting = [guards for guards in options if guards <= explorers]
        guards = max(fitting) if fitting else min(options)
        return options[guards], guards

    def checkpoint_path(self, name):
        if os.path.basename(name) != name:
            raise ValueError(f'not a checkpoint name: {name!r}')
        return os.path.join(self.models_dir, name)

    def load_checkpoint(self, name):
        """A pretrained checkpoint's state dict (weights only: it cannot run code)."""
        return torch.load(self.checkpoint_path(name), map_location='cpu', weights_only=True)
