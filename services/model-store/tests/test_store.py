"""Model records, demonstration chunks, the training queue and object storage.

    TEST_DATABASE_URL=postgres://pml:pml-dev@127.0.0.1:5433/pml \
      .venv/bin/python -m unittest discover -s services/model-store/tests
"""
import tempfile
import threading
import unittest

import boto3
import numpy as np
from moto import mock_aws

from model_store.objects import LocalObjects, S3Objects, open_objects
from model_store.schedule import COOLDOWN_SECONDS, JOB_AFTER_DEMOS, maybe_enqueue
from model_store.serialize import concat_demos, demos_bytes, load_demos, load_model, model_bytes
from model_store.store import Store

from helpers import ADMIN_URL, create_database, drop_database, new_user


class ObjectsTest(unittest.TestCase):
    def test_local_directory(self):
        with tempfile.TemporaryDirectory() as root:
            objects = open_objects(f'file://{root}')
            self.assertIsInstance(objects, LocalObjects)
            objects.put('models/u/2/v1.pt', b'weights')
            self.assertEqual(objects.get('models/u/2/v1.pt'), b'weights')
            objects.delete('models/u/2/v1.pt')
            with self.assertRaises(FileNotFoundError):
                objects.get('models/u/2/v1.pt')
            with self.assertRaises(ValueError):
                objects.put('../escape', b'')

    @mock_aws
    def test_s3(self):
        boto3.client('s3', region_name='us-east-1').create_bucket(Bucket='agents')
        objects = S3Objects('agents', 'pml')
        objects.put('demos/u/2/1.npz', b'chunk')
        self.assertEqual(objects.get('demos/u/2/1.npz'), b'chunk')
        self.assertEqual(boto3.client('s3', region_name='us-east-1').list_objects_v2(Bucket='agents')['Contents'][0]['Key'], 'pml/demos/u/2/1.npz')
        objects.delete('demos/u/2/1.npz')


class SerializeTest(unittest.TestCase):
    def test_round_trips(self):
        import torch
        state = {'head': 'branch', 'noisy': False, 'nets': [{'w': torch.arange(4.0)}]}
        self.assertTrue(torch.equal(load_model(model_bytes(state))['nets'][0]['w'], torch.arange(4.0)))
        demos = {'loc': np.ones((2, 9, 25, 25), np.float16), 'glo': np.zeros((2, 10, 16, 16), np.float16),
                 'vec': np.zeros((2, 40), np.float32), 'mask': np.ones((2, 10), bool), 'act': np.array([[1, 0, 2], [0, 1, 3]]),
                 'credit': np.array([0.1, 0.2], np.float32), 'kcal': np.array([0.01, 0.01], np.float32),
                 'episode': np.array([5, 5]), 'step': np.array([0, 1])}
        back = load_demos(demos_bytes(demos))
        self.assertEqual(back['act'].tolist(), [[1, 0, 2], [0, 1, 3]])
        self.assertEqual(len(concat_demos([back, back])['step']), 4)
        self.assertEqual(concat_demos([])['loc'].shape, (0, 9, 25, 25))


@unittest.skipUnless(ADMIN_URL, 'set TEST_DATABASE_URL')
class StoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.url = create_database()
        cls.store = Store(cls.url)

    @classmethod
    def tearDownClass(cls):
        cls.store.connection().close()
        drop_database(cls.url)

    def test_publishing_is_versioned_and_guards_against_races(self):
        user = new_user(self.url)
        self.assertIsNone(self.store.published(user, '2'))
        self.assertTrue(self.store.publish(user, '2', 0, 'models/a/v1.pt', 'm2_g1.pt', 1, 10, {'cost_after': 1.0}))
        self.assertFalse(self.store.publish(user, '2', 0, 'models/a/v1b.pt', 'm2_g1.pt', 1, 10, {}), 'a second first version loses')
        self.assertTrue(self.store.publish(user, '2', 1, 'models/a/v2.pt', 'm2_g1.pt', 1, 20, {}))
        self.assertFalse(self.store.publish(user, '2', 1, 'models/a/v2b.pt', 'm2_g1.pt', 1, 20, {}), 'stale version loses')
        model = self.store.published(user, '2')
        self.assertEqual((model['version'], model['object_key'], model['demos']), (2, 'models/a/v2.pt', 20))
        self.assertEqual(self.store.versions([(user, '2'), (user, '3')]), {(user, '2'): 2})

    def test_chunks_and_counts(self):
        user = new_user(self.url)
        ids = [self.store.add_chunk(user, '6', f'demos/{k}.npz', 100) for k in range(5)]
        self.assertEqual(self.store.demos_since(user, '6', ids[1]), 300)
        self.assertEqual([c['id'] for c in self.store.chunks(user, '6', 250)], ids[2:])

    def test_queue_claim_lease_finish_and_retry(self):
        user = new_user(self.url)
        job = self.store.enqueue(user, '3', 'test', 0.4, 'm3_g1.pt', 1)
        self.assertEqual(self.store.enqueue(user, '3', 'again', 0.7, 'm3_g1.pt', 1), job, 'one open job per user and plan')
        self.assertEqual(self.store.queue_depth(), 1)
        claimed = self.store.claim('w1', 60)
        self.assertEqual((claimed['id'], claimed['blend']), (job, 0.7))
        self.assertIsNone(self.store.claim('w2', 60), 'nothing else is due')
        self.assertIsNone(self.store.enqueue(user, '3', 'while running', 0.5, 'm3_g1.pt', 1))
        self.assertTrue(self.store.renew(job, 'w1', 60))
        self.assertFalse(self.store.renew(job, 'w2', 60))
        self.store.fail(job, 'w1', 'boom')
        self.assertEqual(self.store.last_job(user, '3')['status'], 'queued')
        self.store.query("update training_jobs set not_before = now() where id = %s", (job,))
        again = self.store.claim('w2', 60)
        self.assertEqual((again['id'], again['attempts']), (job, 2))
        self.store.finish(job, 'w2', {'accepted': True}, 42)
        self.assertEqual(self.store.trained_through(user, '3'), 42)

    def test_a_job_whose_worker_died_is_claimed_again(self):
        user = new_user(self.url)
        job = self.store.enqueue(user, '4', 'test', 0.5, 'm4_g1.pt', 1)
        self.store.claim('dead', 60)
        self.store.query("update training_jobs set lease_until = now() - interval '1 second' where id = %s", (job,))
        self.assertEqual(self.store.claim('alive', 60)['id'], job)

    def test_concurrent_workers_never_share_a_job(self):
        users = [new_user(self.url) for _ in range(12)]
        for user in users:
            self.store.enqueue(user, '1', 'test', 0.5, 'm1_g1.pt', 1)
        claimed, lock = [], threading.Lock()

        def work(name):
            store = Store(self.url)
            while (job := store.claim(name, 60)) is not None:
                with lock:
                    claimed.append(job['id'])
            store.connection().close()
        threads = [threading.Thread(target=work, args=(f'w{k}',)) for k in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(claimed), 12)
        self.assertEqual(len(set(claimed)), 12)

    def test_schedule_needs_enough_new_demonstrations_and_respects_the_cooldown(self):
        user = new_user(self.url)
        self.store.add_chunk(user, '5', 'demos/a.npz', JOB_AFTER_DEMOS - 1)
        self.assertIsNone(maybe_enqueue(self.store, user, '5', 0.5, 'm5_g1.pt', 1))
        job = maybe_enqueue(self.store, user, '5', 0.5, 'm5_g1.pt', 1, finished=True)
        self.assertIsNotNone(job, 'stopping with 30+ new demonstrations is enough')
        # Other tests' jobs share the queue, so run this one directly.
        self.store.query("update training_jobs set status = 'running', worker = 'w' where id = %s", (job,))
        self.store.finish(job, 'w', {}, self.store.chunks(user, '5', 10_000)[-1]['id'])
        self.store.add_chunk(user, '5', 'demos/b.npz', JOB_AFTER_DEMOS)
        second = maybe_enqueue(self.store, user, '5', 0.5, 'm5_g1.pt', 1)
        delay = self.store.query('select extract(epoch from not_before - created_at) as s from training_jobs where id = %s', (second,), one=True)['s']
        self.assertGreater(float(delay), COOLDOWN_SECONDS - 5, 'waits out the cooldown after the last job')

    def test_reset_removes_model_demonstrations_and_open_jobs(self):
        user = new_user(self.url)
        self.store.publish(user, '7', 0, 'models/x/v1.pt', 'm7_g2.pt', 2, 5, {})
        self.store.add_chunk(user, '7', 'demos/x/1.npz', 5)
        job = self.store.enqueue(user, '7', 'test', 0.5, 'm7_g2.pt', 2)
        keys = self.store.reset(user, '7')
        self.assertEqual(sorted(keys), ['demos/x/1.npz', 'models/x/v1.pt'])
        self.assertIsNone(self.store.published(user, '7'))
        self.assertEqual(self.store.last_job(user, '7')['status'], 'cancelled')
        self.assertIsNotNone(self.store.enqueue(user, '7', 'fresh', 0.5, 'm7_g2.pt', 2), 'a new job can be queued after a reset')
        self.assertNotEqual(self.store.last_job(user, '7')['id'], job)


if __name__ == '__main__':
    unittest.main()
