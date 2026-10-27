create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  github_id text unique not null,
  github_login text not null,
  created_at timestamptz not null default now()
);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  name text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id),
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists events (
  id bigserial primary key,
  session_id uuid not null references sessions(id),
  type text not null,
  payload jsonb not null default '{}',
  device_ts timestamptz not null,
  server_ts timestamptz not null default now()
);

create table if not exists commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id),
  type text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  acked_at timestamptz
);

create index if not exists events_session_idx on events(session_id, id);
create index if not exists commands_device_idx on commands(device_id, status);

-- C3: per-device tokens (COD-313)
alter table devices add column if not exists token_hash text;
alter table devices add column if not exists revoked_at timestamptz;

create unique index if not exists devices_token_hash_idx
  on devices(token_hash) where token_hash is not null;
create index if not exists devices_user_idx on devices(user_id);