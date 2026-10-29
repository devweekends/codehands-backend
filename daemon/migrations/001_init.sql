-- L1: local database contract for ~/.codehands/state.db (SQLite)
-- RULE: one writer per table. SQLite can't enforce this, so every table
-- below says who may write it. Everyone else only reads.

-- WRITER: daemon
create table if not exists schema_migrations (
  version    integer primary key,
  applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- WRITER: app
-- repo_id = hash of the origin URL (same project on every laptop).
-- path = folder on THIS laptop only. It never syncs.
create table if not exists projects (
  id         text primary key,
  name       text not null,
  repo_id    text not null unique,
  path       text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- WRITER: app
-- A task with no session yet is waiting for the daemon to pick it up.
create table if not exists tasks (
  id         text primary key,
  project_id text not null references projects(id),
  prompt     text not null,
  agent      text not null check (agent in ('claude-code','codex','codehands')),
  models     text not null default '{}',  -- JSON: model per phase
  created_by text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- WRITER: app
create table if not exists commands (
  id         text primary key,
  session_id text,                         -- null only for 'start'
  project_id text,
  kind       text not null check (kind in ('start','stop','resume','approve','reject')),
  created_by text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- WRITER: daemon
-- unique(task_id): a task can get only one session, so the daemon claims
-- each task exactly once. A second insert for the same task fails.
create table if not exists sessions (
  id          text primary key,
  task_id     text not null unique references tasks(id),
  project_id  text not null references projects(id),
  status      text not null default 'queued'
              check (status in ('queued','running','stopped','awaiting_approval',
                                'approved','rejected','failed')),
  agent       text not null,
  model       text not null,
  reason      text,                        -- why failed or refused
  cost_usd    real not null default 0,
  branch      text,
  base_commit text,
  diff        text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- WRITER: daemon. Append only.
-- (session_id, seq) is the key, so a resend can't create a duplicate.
create table if not exists events (
  session_id text not null references sessions(id),
  seq        integer not null,             -- 1, 2, 3... per session
  type       text not null,
  payload    text not null default '{}',   -- JSON
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (session_id, seq)
);

-- WRITER: daemon
create table if not exists provider_status (
  agent      text primary key,             -- 'claude-code' | 'codex'
  state      text not null check (state in
             ('ok','not_installed','not_logged_in','rate_limited','usage_limited','outage')),
  reason     text,
  retry_at   text,
  checked_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- WRITER: daemon
-- The daemon can't edit the app's commands table, so it records
-- "handled" here instead.
create table if not exists command_receipts (
  command_id text primary key references commands(id),
  outcome    text not null check (outcome in ('done','refused')),
  reason     text,
  handled_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists sessions_status_idx on sessions(status);
create index if not exists commands_session_idx on commands(session_id);