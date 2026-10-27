"""Fine-tuning pieces: turning demonstrations into transitions, and when to publish.

    PYTHONPATH=artifacts:services/trainer:services/trainer/tests python3 -m unittest discover -s services/trainer/tests
"""
import os
import unittest

import numpy as np

from guardrl.plan import load_plan
from trainer.finetune import accept, demo_transitions

from players import record_player

PLAN = load_plan(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'apps', 'web', 'plans', '2. Simple Centre.json'), verbose=False)


class AcceptTest(unittest.TestCase):
    def test_copying_is_always_published_scoring_only_if_not_worse(self):
        self.assertTrue(accept({'cost_before': 1.0, 'cost_after': 3.0}, 0.5))
        self.assertTrue(accept({'cost_before': 1.0, 'cost_after': 1.04}, 0.2))
        self.assertFalse(accept({'cost_before': 1.0, 'cost_after': 1.06}, 0.2))


class TransitionsTest(unittest.TestCase):
    def test_demonstrations_become_n_step_transitions_within_episodes(self):
        plan = PLAN
        demos = record_player(plan, 1, 6)
        demos['episode'][3:] = 1                       # two episodes of three steps
        demos['step'][3:] = np.arange(3)
        replay = demo_transitions(demos, plan)
        self.assertEqual(replay.n, 4, 'the last step of each episode has no next observation')
        self.assertTrue(replay.demo[:replay.n].all())


if __name__ == '__main__':
    unittest.main()
