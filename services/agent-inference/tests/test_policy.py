"""The agent service: checkpoint choice, valid actions for any team, players' tuned agents,
and the HTTP API.

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


def teach(player, plan_id, explorers, action, blend, times):
    body = {**request(plan_id, explorers, [0]), 'player': player, 'agent': 0, 'action': action, 'blend': blend}
    del body['agents']
    for _ in range(times):
        status = POLICIES.demonstrate(body)
    while POLICIES.tuned.train_once():
        pass
    return status


class TuningTest(unittest.TestCase):
    def setUp(self):
        self.explorers = [at_start('2')]
        self.pretrained = POLICIES.act(request('2', self.explorers, [0]))[0]
        # Something the pretrained agent would not do here: sprint south looking west.
        self.taught = [3, 2, 6] if self.pretrained != [3, 2, 6] else [7, 1, 2]

    def tearDown(self):
        POLICIES.tuned.forget('ann')
        POLICIES.tuned.forget('bob')

    def drive(self, owner):
        return POLICIES.act({**request('2', self.explorers, [0]), 'owners': [owner]})[0]

    def test_copying_the_player_learns_their_action(self):
        status = teach('ann', '2', self.explorers, self.taught, blend=1.0, times=48)
        self.assertEqual(status['demos'], 48)
        self.assertGreaterEqual(POLICIES.status('ann', '2')['updates'], 48)
        self.assertEqual(self.drive('ann'), self.taught)
        self.assertEqual(self.drive('bob'), self.pretrained, 'other players keep the pretrained agent')
        self.assertEqual(self.drive(None), self.pretrained)

    def test_staying_pretrained_ignores_the_player(self):
        teach('bob', '2', self.explorers, self.taught, blend=0.0, times=48)
        self.assertEqual(self.drive('bob'), self.pretrained)

    def test_reset_and_forget_bring_back_the_pretrained_agent(self):
        teach('ann', '2', self.explorers, self.taught, blend=1.0, times=48)
        POLICIES.tuned.reset('ann', '2')
        self.assertEqual(self.drive('ann'), self.pretrained)
        self.assertEqual(POLICIES.status('ann', '2')['demos'], 0)
        teach('ann', '2', self.explorers, self.taught, blend=1.0, times=8)
        POLICIES.tuned.forget('ann')
        self.assertIsNone(POLICIES.tuned.get('ann', '2'))

    def test_demonstrations_are_validated(self):
        body = {**request('2', self.explorers, [0]), 'player': 'ann', 'agent': 0, 'action': [10, 0, 0]}
        with self.assertRaises(ValueError):
            POLICIES.demonstrate(body)
        with self.assertRaises(ValueError):
            POLICIES.act({**request('2', self.explorers, [0]), 'owners': ['a', 'b']})


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

    def post(self, body, path='/act'):
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read())

    def test_probes(self):
        for path in ('/healthz', '/readyz'):
            with urllib.request.urlopen(self.url + path) as response:
                self.assertEqual(response.status, 200)

    def test_act_over_http(self):
        reply = self.post(request('2', [at_start('2')], [0]))
        self.assertEqual(len(reply['actions']), 1)

    def test_teaching_resetting_and_forgetting_over_http(self):
        body = {**request('2', [at_start('2')], [0]), 'player': 'carol', 'agent': 0, 'action': [1, 0, 0], 'blend': 0.7}
        del body['agents']
        status = self.post(body, '/demonstrate')
        self.assertEqual((status['demos'], status['blend']), (1, 0.7))
        self.assertEqual(self.post({'player': 'carol', 'plan': '2'}, '/reset'), {})
        self.assertEqual(self.post({'player': 'carol'}, '/forget'), {})

    def test_bad_requests_get_400(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({'plan': '2', 'explorers': [], 'agents': [0], 'means': ''})
        self.assertEqual(caught.exception.code, 400)


if __name__ == '__main__':
    unittest.main()
