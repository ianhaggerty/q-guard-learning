"""Postgres records for players' agents (schema: deploy/db/migrations).

Published models, the demonstration chunks they learn from, and the training queue. Workers
claim jobs with FOR UPDATE SKIP LOCKED, so any number of them can share the queue, and hold
a lease they renew while working; a job whose lease runs out (its worker died) is claimed
again.

A Store is shared by threads. Every method takes one of the store's own connections for a
short transaction; there are at most `max_connections`, so a busy service cannot exhaust the
database's connections, and a thread waits up to `wait_seconds` for one. A connection that
fails is replaced. Failures to reach the database raise model_store.Unavailable.
"""
import json
import threading
from contextlib import contextmanager

import psycopg
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row

from . import Unavailable

#: Failed jobs are retried this many times in all, a minute apart.
MAX_ATTEMPTS = 3


class Store:
    def __init__(self, database_url, max_connections=4, wait_seconds=5):
        self.url, self.wait_seconds = database_url, wait_seconds
        self.slots = threading.BoundedSemaphore(max_connections)
        self.idle, self.lock = [], threading.Lock()

    @contextmanager
    def connection(self):
        """One of the store's connections, for the with block."""
        if not self.slots.acquire(timeout=self.wait_seconds):
            raise Unavailable('every database connection is busy')
        conn = None
        try:
            with self.lock:
                conn = self.idle.pop() if self.idle else None
            if conn is None or conn.closed:
                conn = psycopg.connect(self.url, autocommit=True, row_factory=dict_row, connect_timeout=5)
            yield conn
        except psycopg.OperationalError as error:
            raise Unavailable(str(error).strip()) from error
        finally:
            if conn is not None and not conn.closed and conn.info.transaction_status == TransactionStatus.IDLE:
                with self.lock:
                    self.idle.append(conn)
            elif conn is not None:
                conn.close()
            self.slots.release()

    def close(self):
        with self.lock:
            idle, self.idle = self.idle, []
        for conn in idle:
            conn.close()

    def query(self, sql, params=(), one=False, conn=None):
        if conn is None:
            with self.connection() as conn:
                return self.query(sql, params, one, conn)
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            if cursor.description is None:
                return None
            return cursor.fetchone() if one else cursor.fetchall()

    # ------------------------------------------------------------------ models

    def published(self, user_id, plan_id):
        return self.query('select * from agent_models where user_id = %s and plan_id = %s', (user_id, plan_id), one=True)

    def versions(self, pairs):
        """{(user_id, plan_id): version} for the published models among `pairs`."""
        if not pairs:
            return {}
        rows = self.query('select user_id::text, plan_id, version from agent_models where (user_id::text, plan_id) in (select * from unnest(%s::text[], %s::text[]))',
                          ([u for u, _ in pairs], [p for _, p in pairs]))
        return {(row['user_id'], row['plan_id']): row['version'] for row in rows}

    def publish(self, user_id, plan_id, expected_version, object_key, base_checkpoint, guards, demos, report):
        """Make object_key the user's model for the plan, if it is still at expected_version
        (0: none yet). Returns False when it moved on meanwhile (another publish or a reset)."""
        if expected_version == 0:
            row = self.query("""insert into agent_models (user_id, plan_id, version, object_key, base_checkpoint, guards, demos, report)
                                values (%s, %s, 1, %s, %s, %s, %s, %s) on conflict do nothing returning version""",
                             (user_id, plan_id, object_key, base_checkpoint, guards, demos, json.dumps(report)), one=True)
        else:
            row = self.query("""update agent_models set version = version + 1, object_key = %s, demos = %s, report = %s, updated_at = now()
                                where user_id = %s and plan_id = %s and version = %s returning version""",
                             (object_key, demos, json.dumps(report), user_id, plan_id, expected_version), one=True)
        return row is not None

    def reset(self, user_id, plan_id):
        """Forget the user's agent for the plan: its model, demonstrations and open jobs.
        Returns the object keys that are no longer needed."""
        with self.connection() as conn, conn.transaction():
            model = self.query('delete from agent_models where user_id = %s and plan_id = %s returning object_key', (user_id, plan_id), True, conn)
            chunks = self.query('delete from demo_chunks where user_id = %s and plan_id = %s returning object_key', (user_id, plan_id), conn=conn)
            self.query("""update training_jobs set status = 'cancelled', finished_at = now()
                          where user_id = %s and plan_id = %s and status in ('queued', 'running')""", (user_id, plan_id), conn=conn)
        return ([model['object_key']] if model else []) + [chunk['object_key'] for chunk in chunks]

    # ------------------------------------------------------------------ demonstrations

    def add_chunk(self, user_id, plan_id, object_key, demos):
        return self.query('insert into demo_chunks (user_id, plan_id, object_key, demos) values (%s, %s, %s, %s) returning id',
                          (user_id, plan_id, object_key, demos), one=True)['id']

    def chunks(self, user_id, plan_id, max_demos):
        """The newest chunks holding about max_demos demonstrations, oldest first."""
        rows = self.query('select id, object_key, demos from demo_chunks where user_id = %s and plan_id = %s order by id desc',
                          (user_id, plan_id))
        kept, total = [], 0
        for row in rows:
            if total >= max_demos:
                break
            kept.append(row)
            total += row['demos']
        return kept[::-1]

    def demos_since(self, user_id, plan_id, chunk_id):
        row = self.query('select coalesce(sum(demos), 0) as n from demo_chunks where user_id = %s and plan_id = %s and id > %s',
                         (user_id, plan_id, chunk_id), one=True)
        return int(row['n'])

    def trained_through(self, user_id, plan_id):
        """The newest chunk a finished job has trained on (0 for none)."""
        row = self.query("""select coalesce(max(last_chunk), 0) as chunk from training_jobs
                            where user_id = %s and plan_id = %s and status = 'done'""", (user_id, plan_id), one=True)
        return int(row['chunk'])

    # ------------------------------------------------------------------ the training queue

    def last_job(self, user_id, plan_id):
        return self.query('select * from training_jobs where user_id = %s and plan_id = %s order by id desc limit 1',
                          (user_id, plan_id), one=True)

    def enqueue(self, user_id, plan_id, reason, blend, base_checkpoint, guards, cooldown_seconds=0):
        """Queue a job, to start no sooner than cooldown_seconds after the user's last job for
        the plan. If one is already queued it just takes the newest blend. Returns the job id
        (the queued one's when there was one), or None while one is running. base_checkpoint
        and guards say where a user's first model starts."""
        row = self.query("""insert into training_jobs (user_id, plan_id, reason, blend, base_checkpoint, guards, not_before)
                            values (%s, %s, %s, %s, %s, %s, greatest(now(), coalesce(
                              (select max(created_at) from training_jobs where user_id = %s and plan_id = %s and status <> 'cancelled'),
                              now() - make_interval(secs => %s)) + make_interval(secs => %s)))
                            on conflict (user_id, plan_id) where status in ('queued', 'running')
                            do update set blend = excluded.blend where training_jobs.status = 'queued'
                            returning id""",
                         (user_id, plan_id, reason, blend, base_checkpoint, guards, user_id, plan_id, cooldown_seconds, cooldown_seconds),
                         one=True)
        return row['id'] if row else None

    def claim(self, worker, lease_seconds):
        """Take the oldest due job (or one whose worker's lease ran out). Returns it or None."""
        return self.query("""update training_jobs set status = 'running', worker = %s, started_at = now(), attempts = attempts + 1,
                                    lease_until = now() + make_interval(secs => %s)
                             where id = (select id from training_jobs
                                         where (status = 'queued' and not_before <= now())
                                            or (status = 'running' and lease_until < now())
                                         order by not_before for update skip locked limit 1)
                             returning *""", (worker, lease_seconds), one=True)

    def renew(self, job_id, worker, lease_seconds):
        """Extend the lease. Returns False if the job is no longer this worker's (cancelled or taken over)."""
        row = self.query("""update training_jobs set lease_until = now() + make_interval(secs => %s)
                            where id = %s and worker = %s and status = 'running' returning id""",
                         (lease_seconds, job_id, worker), one=True)
        return row is not None

    def finish(self, job_id, worker, result, last_chunk):
        self.query("""update training_jobs set status = 'done', finished_at = now(), result = %s, last_chunk = %s, lease_until = null
                      where id = %s and worker = %s and status = 'running'""", (json.dumps(result), last_chunk, job_id, worker))

    def fail(self, job_id, worker, error):
        """Record a failure: back to the queue a minute later, or failed for good after MAX_ATTEMPTS."""
        self.query("""update training_jobs set error = %s, lease_until = null, worker = null,
                             status = case when attempts >= %s then 'failed' else 'queued' end,
                             finished_at = case when attempts >= %s then now() end,
                             not_before = now() + interval '1 minute'
                      where id = %s and worker = %s and status = 'running'""",
                   (str(error)[:2000], MAX_ATTEMPTS, MAX_ATTEMPTS, job_id, worker))

    def queue_depth(self):
        """Jobs due now and not yet claimed (what the trainer autoscaler watches)."""
        return int(self.query("select count(*) as n from training_jobs where status = 'queued' and not_before <= now()", one=True)['n'])
