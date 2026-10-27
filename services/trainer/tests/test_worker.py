"""Training jobs end to end: the queue, a fine-tune and publishing.

    TEST_DATABASE_URL=postgres://pml:pml-dev@127.0.0.1:5433/pml \
      PYTHONPATH=artifacts:services/model-store:services/model-store/tests:services/trainer:services/trainer/tests \
      .venv/bin/python -m unittest discover -s services/trainer/tests
"""
import tempfile
import unittest
from unittest import mock

import numpy as np

from model_store.catalog import Catalog
from model_store.objects import LocalObjects
from model_store.serialize import demos_bytes, load_model
from model_store.store import Store
from trainer import worker as worker_module

from helpers import ADMIN_URL, create_database, drop_database, new_user
from players import record_player

CATALOG = Catalog()
FAST = dict(env_steps=12, n_envs=2, updates_per_step=1, eval_seconds=10)


@unittest.skipUnless(ADMIN_URL, 'set TEST_DATABASE_URL')
class WorkerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.url = create_database()
        cls.store = Store(cls.url)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.objects = LocalObjects(cls.tmp.name)
        cls.demos = record_player(CATALOG.plan('2'), 1, 40)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        drop_database(cls.url)
        cls.tmp.cleanup()

    def teach(self, user, plan_id='2'):
        key = f'demos/{user}/{plan_id}/{np.random.randint(1e9)}.npz'
        self.objects.put(key, demos_bytes(self.demos))
        return self.store.add_chunk(user, plan_id, key, len(self.demos['act']))

    def test_jobs_publish_versions_that_build_on_each_other(self):
        user = new_user(self.url)
        chunk = self.teach(user)
        self.store.enqueue(user, '2', 'test', 0.9, 'm2_g1.pt', 1)
        worker_module.work(self.store, self.objects, CATALOG, 'w1', once=True, settings=FAST)
        job = self.store.last_job(user, '2')
        self.assertEqual(job['status'], 'done')
        self.assertTrue(job['result']['published'])
        self.assertEqual(job['last_chunk'], chunk)
        model = self.store.published(user, '2')
        self.assertEqual((model['version'], model['guards'], model['base_checkpoint']), (1, 1, 'm2_g1.pt'))
        self.assertEqual(sorted(load_model(self.objects.get(model['object_key']))), ['head', 'nets', 'noisy'])

        self.teach(user)
        self.store.enqueue(user, '2', 'test', 0.9, 'ignored once published', 1)
        worker_module.work(self.store, self.objects, CATALOG, 'w1', once=True, settings=FAST)
        second = self.store.last_job(user, '2')
        self.assertEqual(second['result']['from_version'], 1)
        self.assertEqual(self.store.published(user, '2')['version'], 2)

    def test_a_reset_during_the_job_wins(self):
        user = new_user(self.url)
        self.teach(user)
        self.store.enqueue(user, '2', 'test', 0.9, 'm2_g1.pt', 1)
        job = self.store.claim('w2', 60)
        real = worker_module.finetune

        def racing(*args, **kwargs):           # another version is published while this job trains
            self.store.publish(user, '2', 0, 'models/other.pt', 'm2_g1.pt', 1, 1, {})
            return real(*args, **kwargs)
        with mock.patch.object(worker_module, 'finetune', side_effect=racing):
            result, _ = worker_module.run_job(job, self.store, self.objects, CATALOG, 'w2', FAST)
        self.assertTrue(result['accepted'])
        self.assertFalse(result['published'])
        self.assertEqual(self.store.published(user, '2')['object_key'], 'models/other.pt')

    def test_a_failing_job_goes_back_to_the_queue(self):
        user = new_user(self.url)
        self.store.enqueue(user, '3', 'test', 0.5, 'm3_g1.pt', 1)
        with mock.patch.object(worker_module, 'finetune', side_effect=RuntimeError('simulated')):
            worker_module.work(self.store, self.objects, CATALOG, 'w3', once=True, settings=FAST)
        job = self.store.last_job(user, '3')
        self.assertEqual((job['status'], job['attempts']), ('queued', 1))
        self.assertIn('simulated', job['error'])


if __name__ == '__main__':
    unittest.main()
