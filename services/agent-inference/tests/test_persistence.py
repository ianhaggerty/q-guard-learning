"""Keeping logged-in players' agents: chunks of demonstrations, training jobs, published
versions driving, the version poller, and resets.

    TEST_DATABASE_URL=postgres://pml:pml-dev@127.0.0.1:5433/pml \
      PYTHONPATH=artifacts:services/model-store:services/model-store/tests:services/agent-inference \
      .venv/bin/python -m unittest discover -s services/agent-inference/tests
"""
import base64
import copy
import tempfile
import unittest

import numpy as np

from agent_inference.persistence import CHUNK_DEMOS, Persistence
from agent_inference.policy import Policies, agent_from_state
from model_store.objects import LocalObjects
from model_store.serialize import model_bytes
from model_store.store import Store

try:
    from helpers import ADMIN_URL, create_database, drop_database, new_user
except ImportError:   # model_store's test helpers are not on the path
    ADMIN_URL = None


@unittest.skipUnless(ADMIN_URL, 'set TEST_DATABASE_URL and put services/model-store/tests on PYTHONPATH')
class PersistenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.url = create_database()
        cls.store = Store(cls.url)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.objects = LocalObjects(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        drop_database(cls.url)
        cls.tmp.cleanup()

    def policies(self):
        return Policies(persistence=Persistence(self.store, self.objects, poll_seconds=3600))

    def state(self, policies, plan_id='2'):
        plan = policies.plan(plan_id)
        start = plan.starts[0]
        explorers = [{'x': start['x'], 'y': start['y'], 'floor': start['floor'], 'heading': 0, 'look': 0, 'gait': 0,
                      'sitting': False, 'seat': -1}]
        return {'plan': plan_id, 'explorers': explorers, 'means': base64.b64encode(np.zeros(len(plan.cand_w), np.float32).tobytes()).decode()}

    def demonstrate(self, policies, player, n, action=(3, 2, 6), blend=1.0, start_step=0):
        for step in range(start_step, start_step + n):
            status = policies.demonstrate({**self.state(policies), 'player': player, 'agent': 0, 'action': list(action),
                                           'blend': blend, 'credit': 0.001, 'kcal': 0.01, 'episode': 1, 'step': step})
        return status

    def drive(self, policies, player):
        return policies.act({**self.state(policies), 'agents': [0], 'owners': [player]})[0]

    def test_a_users_demonstrations_are_saved_in_chunks_and_queue_training(self):
        user, policies = new_user(self.url), self.policies()
        self.demonstrate(policies, f'user:{user}', CHUNK_DEMOS - 1)
        self.assertEqual(self.store.demos_since(user, '2', 0), 0, 'nothing saved before a chunk fills')
        self.demonstrate(policies, f'user:{user}', 1, start_step=CHUNK_DEMOS - 1)
        self.assertEqual(self.store.demos_since(user, '2', 0), CHUNK_DEMOS)
        job = self.store.last_job(user, '2')
        self.assertEqual((job['status'], job['base_checkpoint'], job['guards'], job['blend']), ('queued', 'm2_g1.pt', 1, 1.0))

    def test_stopping_teaching_saves_what_is_pending(self):
        user, policies = new_user(self.url), self.policies()
        self.demonstrate(policies, f'user:{user}', 40)
        policies.flush(f'user:{user}', '2')
        self.assertEqual(self.store.demos_since(user, '2', 0), 40)
        self.assertEqual(self.store.last_job(user, '2')['reason'], 'stopped teaching')

    def test_leaving_saves_pending_demonstrations(self):
        user, policies = new_user(self.url), self.policies()
        self.demonstrate(policies, f'user:{user}', 10)
        policies.forget(f'user:{user}')
        self.assertEqual(self.store.demos_since(user, '2', 0), 10)

    def test_guests_are_never_saved(self):
        policies = self.policies()
        self.demonstrate(policies, 'guest:abc', CHUNK_DEMOS + 5)
        self.assertIsNone(self.store.query("select 1 from demo_chunks where object_key like 'demos/guest%%'", one=True))

    def publish_taught(self, user, action, version=0):
        """Publish, as the trainer would, a model taught to take `action` from the start."""
        teacher = self.policies()
        self.demonstrate(teacher, 'guest:teacher', 48, action=action)
        while teacher.tuned.train_once():
            pass
        model = teacher.tuned.get('guest:teacher', '2')
        state = copy.deepcopy(teacher.agent('m2_g1.pt').state_dict())
        state['nets'] = [model.net.state_dict()]
        key = f'models/{user}/2/v{version + 1}.pt'
        self.objects.put(key, model_bytes(state))
        self.assertTrue(self.store.publish(user, '2', version, key, 'm2_g1.pt', 1, 48, {'cost_after': 0.1}))

    def test_a_published_model_drives_and_newer_versions_take_over(self):
        user = new_user(self.url)
        pretrained = self.drive(self.policies(), 'guest:nobody')
        first = [3, 2, 6] if pretrained != [3, 2, 6] else [7, 1, 2]
        self.publish_taught(user, first)
        policies = self.policies()   # a fresh process: nothing in memory
        self.assertEqual(self.drive(policies, f'user:{user}'), first)
        self.assertEqual(policies.status(f'user:{user}', '2')['version'], 1)

        second = [5, 0, 4] if first != [5, 0, 4] else [1, 0, 0]
        self.publish_taught(user, second, version=1)
        self.assertEqual(policies.persistence.poll(policies.tuned, lambda state: agent_from_state(state).nets[0]), 1)
        self.assertEqual(self.drive(policies, f'user:{user}'), second)

    def test_reset_clears_storage(self):
        user, policies = new_user(self.url), self.policies()
        self.publish_taught(user, [3, 2, 6])
        self.demonstrate(policies, f'user:{user}', 5)
        policies.flush(f'user:{user}', '2')
        policies.reset(f'user:{user}', '2')
        self.assertIsNone(self.store.published(user, '2'))
        self.assertEqual(self.store.demos_since(user, '2', 0), 0)
        self.assertEqual(policies.status(f'user:{user}', '2')['version'], 0)


if __name__ == '__main__':
    unittest.main()
