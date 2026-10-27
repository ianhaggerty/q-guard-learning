"""When to run reward-driven training for a player's agent, from measurements.

A job (trainer.finetune, 400 vector steps of 8 simulated environments) takes about 50 s on
2 CPU threads for a small plan and about 80 s on 4 for the largest with two guards; more
threads do not help (small batches). Agreement with the player rises from ~2 % to ~80 % in
one job on two minutes of demonstrations, so a job is worth running once there is about a
minute of new teaching, but not more often than the queue can afford:
  * JOB_AFTER_DEMOS new demonstrations (one minute of teaching) queue a job;
  * when the player stops teaching, FINAL_JOB_MIN_DEMOS new ones are enough;
  * a user's agent for one plan trains at most once per COOLDOWN_SECONDS, so a player who
    teaches continuously costs about 6 jobs an hour, and a 2-CPU worker (about 60 jobs an
    hour) serves about 8 players teaching at once.
"""
JOB_AFTER_DEMOS = 120
FINAL_JOB_MIN_DEMOS = 30
COOLDOWN_SECONDS = 600


def maybe_enqueue(store, user_id, plan_id, blend, base_checkpoint, guards, finished=False):
    """Queue a training job if enough new demonstrations have arrived. Returns the job id or None."""
    since = store.demos_since(user_id, plan_id, store.trained_through(user_id, plan_id))
    if since < (FINAL_JOB_MIN_DEMOS if finished else JOB_AFTER_DEMOS):
        return None
    reason = 'stopped teaching' if finished else f'{since} new demonstrations'
    return store.enqueue(user_id, plan_id, reason, blend, base_checkpoint, guards, cooldown_seconds=COOLDOWN_SECONDS)
