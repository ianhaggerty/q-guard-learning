"""The agent service: checkpoint choice, valid actions for any team, and the HTTP API.

Run from the repository root:
    PYTHONPATH=artifacts:services/agent-inference python3 -m unittest discover -s services/agent-inference/tests
"""
import base64
import json
import unittest
import urllib.error
import urllib.request

import numpy as np

from agent_inference.policy import Policies
from agent_inference.server import serve

POLICIES = Policies()


def request(plan_id, explorers, agents, means=None):
    plan = POLICIES.plan(plan_id)
    if means is None:
        means = np.zeros(len(plan.cand_w), np.float32)
    return {'plan': plan_id, 'explorers': explorers, 'agents': agents, 'means': base64.b64encode(means.tobytes()).decode()}


def at_start(plan_id, k=0, **pose):
    start = POLICIES.plan(plan_id).starts[k % len(POLICIES.plan(plan_id).starts)]
    return {'x': start['x'], 'y': start['y'], 'floor': start['floor'], 'heading': 0, 'look': 0, 'gait': 0,
            'sitting': False, 'seat': -1, **pose}


class PolicyTest(unittest.TestCase):
    def test_every_plan_has_checkpoints_and_the_team_size_picks_one(self):
        self.assertEqual(sorted(POLICIES.checkpoints, key=int), ['1', '2', '3', '4', '5', '6', '7'])
        self.assertTrue(POLICIES.checkpoint_for('7', 1).endswith('m7_g1.pt'))
        self.assertTrue(POLICIES.checkpoint_for('7', 2).endswith('m7_g2.pt'))
        self.assertTrue(POLICIES.checkpoint_for('7', 6).endswith('m7_g3.pt'))
        self.assertTrue(POLICIES.checkpoint_for('1', 4).endswith('m1_g1.pt'))

    def test_actions_are_in_the_training_action_space(self):
        for plan_id, team in (('2', 1), ('3', 2), ('6', 3)):
            explorers = [at_start(plan_id, k) for k in range(team)]
            actions = POLICIES.act(request(plan_id, explorers, list(range(team))))
            self.assertEqual(len(actions), team)
            for move, gait, gaze in actions:
                self.assertIn(move, range(10))
                self.assertIn(gait, range(3))
                self.assertIn(gaze, range(8))

    def test_only_the_driven_explorers_get_actions_and_decisions_are_deterministic(self):
        explorers = [at_start('6', 0), at_start('6', 1)]
        rng = np.random.default_rng(1)
        means = rng.random(len(POLICIES.plan('6').cand_w)).astype(np.float32) * 1e-3
        first = POLICIES.act(request('6', explorers, [1], means))
        self.assertEqual(len(first), 1)
        self.assertEqual(first, POLICIES.act(request('6', explorers, [1], means)))

    def test_invalid_requests_are_rejected(self):
        explorers = [at_start('2')]
        with self.assertRaises(ValueError):
            POLICIES.act(request('2', explorers, [1]))
        with self.assertRaises(ValueError):
            POLICIES.act(request('2', explorers, [0], np.zeros(3, np.float32)))
        with self.assertRaises(KeyError):
            POLICIES.act({**request('2', explorers, [0]), 'plan': '99'})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.ready = serve(port=0, preload=False)
        cls.url = f'http://127.0.0.1:{cls.server.server_address[1]}'
        cls.ready.wait(10)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body):
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.url + '/act', data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read())

    def test_probes(self):
        for path in ('/healthz', '/readyz'):
            with urllib.request.urlopen(self.url + path) as response:
                self.assertEqual(response.status, 200)

    def test_act_over_http(self):
        reply = self.post(request('2', [at_start('2')], [0]))
        self.assertEqual(len(reply['actions']), 1)

    def test_bad_requests_get_400(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({'plan': '2', 'explorers': [], 'agents': [0], 'means': ''})
        self.assertEqual(caught.exception.code, 400)


if __name__ == '__main__':
    unittest.main()
