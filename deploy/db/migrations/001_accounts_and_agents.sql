-- Accounts, logins, players' fine-tuned agents and the training queue.

create table users (
  id uuid primary key default gen_random_uuid(),
  github_id bigint unique,          -- null for development logins
  login text not null unique,       -- the GitHub login, or "dev:<name>"
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- A browser's login: the cookie holds a random token; only its SHA-256 is stored.
create table login_sessions (
  token_hash bytea primary key,
  user_id uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index login_sessions_user on login_sessions (user_id);

-- Each user's published agent per plan; weights live in object storage at object_key.
create table agent_models (
  user_id uuid not null references users on delete cascade,
  plan_id text not null,
  version integer not null,
  object_key text not null,
  base_checkpoint text not null,    -- the pretrained checkpoint it descends from
  guards integer not null,          -- team size that checkpoint was trained for
  demos integer not null default 0, -- demonstrations it has been trained on
  report jsonb,                     -- the training job's measurements
  updated_at timestamptz not null default now(),
  primary key (user_id, plan_id)
);

-- Demonstrations, stored in chunks (one object each) as they arrive.
create table demo_chunks (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  plan_id text not null,
  object_key text not null,
  demos integer not null,
  created_at timestamptz not null default now()
);
create index demo_chunks_owner on demo_chunks (user_id, plan_id, id);

-- Reward-driven fine-tuning jobs. Workers claim them with FOR UPDATE SKIP LOCKED and hold a
-- lease they renew while working; a job whose lease runs out goes back to the queue.
create table training_jobs (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  plan_id text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  reason text not null,
  blend real not null,
  base_checkpoint text not null,    -- where a user's first model starts (later jobs start from their published model)
  guards integer not null,
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  worker text,
  lease_until timestamptz,
  attempts integer not null default 0,
  last_chunk bigint,                -- the newest demonstration chunk the job trained on
  result jsonb,
  error text
);
-- At most one open job per user and plan.
create unique index training_jobs_open on training_jobs (user_id, plan_id) where status in ('queued', 'running');
create index training_jobs_queue on training_jobs (not_before) where status = 'queued';
