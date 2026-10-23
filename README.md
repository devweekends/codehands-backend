# codehands-backend

The cloud side of Code Hands AI. In the current design it **stores state and runs nothing**: it holds accounts, devices and a synced copy of your sessions, memory and preferences, so signing in on another machine brings your work with you. Tasks always run on your own machine.

**Owner:** Memoona
**Contract:** C3 (cloud API) in [codehands-contracts](https://github.com/devweekends/codehands-contracts)
**Part of:** [Code Hands AI](https://github.com/devweekends/codehands-docs). Read the design in that README first.

> **Read this first.** What is in this repo today is the **week 1 relay**, built for the first design, where a phone sent commands through the cloud to the laptop. The design has since moved to local-first ([docs README](https://github.com/devweekends/codehands-docs#design)). The daemon in `src/daemon.ts` moves out to `codehands-daemon` (Midhat), and this repo becomes the state API plus the `@codehands/sync` client. Both halves are described below: [what runs today](#what-runs-today) and [where it is going](#where-it-is-going).

## Where it sits

```mermaid
flowchart LR
  subgraph A["Desktop A: where the work runs"]
    app["Desktop app"]
    daemon["Daemon"]
    sync["@codehands/sync (this repo)"]
    daemon --- sync
  end
  subgraph C["Cloud: state only"]
    api["State API (this repo)"]
    pg[("Postgres")]
    api --> pg
  end
  subgraph B["Desktop B: same account"]
    daemonB["Daemon"]
  end
  app -- "C3: sign up, log in" --> api
  sync -- "C3: push(changes)" --> api
  api -- "C3: pull(cursor) on sign-in" --> daemonB
```

## Where it is going

This repo will ship two things:

| Part | What | Runs |
| --- | --- | --- |
| State API | Auth and device tokens, the synced schema in Postgres, `push` and `pull` endpoints, hosting | On our Linux server |
| `@codehands/sync` | A small library the daemon loads. It pushes local changes up and pulls remote ones down, and the daemon writes them into `state.db` | Inside the daemon on each machine |

The sync client is a library, not a process. One rule of the design is that only the daemon does work; another is that only the daemon writes the local tables other than `tasks` and `commands`. So the sync client hands rows to the daemon, and the daemon writes them.

### What syncs

| Data | Synced | How |
| --- | --- | --- |
| Account, devices | Yes | Logging out on one machine revokes only that machine's token |
| Projects | Yes | By repo identity (a hash of the origin URL), not folder path. Each machine maps it to its own clone |
| Sessions | Yes | Prompt, agent, models, status, branch name, cost, times |
| Events | Yes | Append only, keyed by session and `seq`, so a resend is harmless. Raw agent output stripped |
| Diff | Small ones | Up to a size cap |
| Memory | Yes | Repo notes, task summaries, user memory, as versioned records |
| Preferences | Yes | Default agent, model per phase, app settings. Last write wins |
| Repo files, worktrees | **Never** | Each machine uses its own clone. A branch reaches another machine through GitHub |
| Credentials | **Never** | Agent logins, API keys, the app token. Each machine signs in itself |
| Raw output, big logs | **Never** | Stay in `~/.codehands/` on the machine that made them |

### API to build (C3)

| Area | Endpoints |
| --- | --- |
| Auth | Sign up, log in, log out. Each login creates a device token; the desktop app keeps it in the OS keychain |
| Devices | List devices, revoke one |
| Sync | `push(changes)` with record versions, `pull(cursor)` returning everything after the cursor |

The shapes go into codehands-contracts first, with a mock server holding accounts in memory so the desktop app and the daemon can build against it before this API is live.

## What runs today

A Fastify server with Postgres and a WebSocket, plus a demo daemon that pretends to run tasks. It proves the week 1 loop: a command sent over HTTP reaches a laptop over its open connection, and the laptop's events come back and are stored within a second.

```mermaid
sequenceDiagram
  participant P as Caller (curl, phone)
  participant S as Server (src/server.ts)
  participant DB as Postgres
  participant D as Daemon (src/daemon.ts)
  D->>S: WS /ws?token=…&deviceId=…
  S-->>D: { type: "hello" }
  P->>S: POST /commands { deviceId, type: "start" }
  S->>DB: insert command, insert session (running)
  S-->>D: { type: "command", commandType: "start", sessionId }
  S-->>P: { commandId, sessionId, delivered: true }
  D->>S: { type: "ack", commandId }
  S->>DB: command acked
  loop each step
    D->>S: { type: "event", sessionId, eventType, clientEventId }
    S->>DB: insert event
    S-->>D: { type: "event_ack", clientEventId }
    Note over D: logs the round trip in ms
  end
```

### Files

| Path | What |
| --- | --- |
| [src/server.ts](src/server.ts) | HTTP and WebSocket on one port. Keeps a map of connected daemons by device id |
| [src/daemon.ts](src/daemon.ts) | Demo daemon. Connects, reconnects every 2 s after a drop, acks commands and plays a scripted task. Moving to `codehands-daemon` |
| [src/migrate.ts](src/migrate.ts) | Applies `db/schema.sql` |
| [src/testclient.ts](src/testclient.ts) | An earlier hand-test client with a hard-coded device id and token |
| [db/schema.sql](db/schema.sql) | Five tables: `users`, `devices`, `sessions`, `events`, `commands` |
| [bin/codehands.js](bin/codehands.js) | `codehands start` runs the daemon |

### HTTP

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /health` | | `{ ok: true, db_time }`. Proves the database is reachable |
| `POST /commands` | `{ deviceId, type, payload? }`, `type` one of `start`, `stop`, `approve`, `reject` | `{ commandId, sessionId, delivered: true }`, or `202 { commandId, delivered: false }` when that device is not connected |

A `start` creates a session row and passes its id to the daemon. Other commands take the session id in `payload.sessionId`.

### WebSocket messages

Connect to `/ws?token=<DEV_TOKEN>&deviceId=<uuid>`. A wrong token closes the socket with code `4001`.

| Direction | `type` | Fields |
| --- | --- | --- |
| Server → daemon | `hello` | `deviceId` |
| Server → daemon | `command` | `commandId`, `commandType`, `sessionId`, `payload` |
| Daemon → server | `ack` | `commandId`. Marks the command `acked` |
| Daemon → server | `event` | `sessionId`, `eventType`, `clientEventId`, `payload`, `deviceTs` |
| Server → daemon | `event_ack` | `clientEventId`, once the event is stored |

The demo daemon answers `start` with `task.started`, `step.plan`, `step.implement`, `approval.requested`; `approve` with `step.test`, `task.finished`; `stop` and `reject` with `task.stopped` and `task.rejected`.

### Run it

You need Node 22 and a Postgres 13 or newer (for `gen_random_uuid()`), local or hosted.

```bash
npm install
```

Create `.env` in the repo root. It is git-ignored.

```bash
DATABASE_URL=postgres://user:password@localhost:5432/codehands
PORT=3000
DEV_TOKEN=pick-a-long-random-string     # shared secret between server and daemon

# for the daemon
SERVER_URL=ws://localhost:3000/ws
DEVICE_ID=                              # filled in below
```

Create the tables, then a user and a device by hand (there is no sign-up yet):

```bash
npm run migrate
psql "$DATABASE_URL" -c "
  with u as (insert into users (github_id, github_login) values ('0', 'dev') returning id)
  insert into devices (user_id, name) select id, 'my-laptop' from u returning id;"
```

Put the returned id in `DEVICE_ID`. Then, in two terminals:

```bash
npm run dev       # server, restarts on change
npm run daemon    # or: npx codehands start, from the repo root
```

Send a command and watch both terminals:

```bash
curl -s localhost:3000/health
curl -s -X POST localhost:3000/commands \
  -H 'content-type: application/json' \
  -d '{"deviceId":"<DEVICE_ID>","type":"start"}'
# → { "commandId": "…", "sessionId": "…", "delivered": true }

curl -s -X POST localhost:3000/commands \
  -H 'content-type: application/json' \
  -d '{"deviceId":"<DEVICE_ID>","type":"approve","payload":{"sessionId":"<sessionId>"}}'
```

Look at what was stored:

```sql
select type, device_ts, server_ts - device_ts as lag from events order by id desc limit 10;
select type, status, acked_at from commands order by created_at desc limit 5;
```

### Known gaps

These are fine for a week 1 demo and are what the next version fixes.

| Gap | Why it matters |
| --- | --- |
| One shared `DEV_TOKEN`, sent in the query string | No real accounts or per-device tokens. Query strings end up in logs |
| A command for an offline device is stored as `queued` and never re-sent | The daemon misses it after reconnecting |
| The schema does not match the contracts | Statuses here are `pending`, `running`, `finished`; the contracts have seven others. No `projects` table, no `seq` on events |
| Event names are the demo's (`step.plan`, `approval.requested`) | The contracts' `RunnerEvent` types replace them |
| No build script, tests or CI | Scripts run through `tsx`. `bin/codehands.js` must be run from the repo root |

## Contributing

- One branch per Linear issue, the issue id in the PR title.
- Any change to what the API accepts or returns is a C3 change: [codehands-contracts](https://github.com/devweekends/codehands-contracts#changing-a-contract) first, then here, and the mock server updated the same week.
- Credentials, repo files and raw agent output must never reach this server. If a change would send them, it is the wrong change.
- No secrets in code or logs. Configuration comes from `.env` locally and from the host's secret store in production.
