# Schedule Tool

`schedule` tool — LLM schedules recurring prompts via cron syntax.

## Usage

```
call({ name: "disk-check", prompt: "Check disk usage and alert if above 90%", cron: "*/5 * * * *" })
call({ name: "disk-check", action: "pause" })
call({ name: "disk-check", action: "resume" })
call({ name: "disk-check", action: "delete" })
```

No `action` field = create. `prompt` and `cron` required for create only.

## How it works

- Schedules persist in SQLite (survive restarts)
- Heartbeat checks for due crons on each tick (cheap — scan table, compare timestamps)
- Due crons push events to the queue: `{ source: "cron", type: "scheduled", payload: { name, prompt } }`
- Normal event loop picks them up, feeds prompt to LLM
- Crons always run. No global idle/active flag.

## "Think" prompt

The proactive idle behavior ("wake up and look around") is just another cron:

```
call({ name: "think", prompt: "Check for unfinished work, look around", cron: "*/2 * * * *" })
```

The user can disable this cron from the settings UI to save cost. No special idle mode —
just a cron that can be toggled like any other.

## Settings UI

All crons are visible in the settings UI. Each one can be enabled/disabled individually.
This gives the user granular cost control — disable the think cron but keep disk checks running,
or pause everything during off-hours.

## Heartbeat responsibilities

The heartbeat loop (fires every `HEARTBEAT_MS`) does two things:

1. **Compaction check** — always runs, algorithmic, no LLM cost. Independent of crons.
2. **Cron check** — scan due crons, push events to queue. Cheap.

No concept of idle/busy state. The heartbeat just ticks. Compaction maintains context.
Crons drive proactive behavior. Events drive reactive behavior.

## Typical workflow

1. LLM decides it needs to monitor something
2. `schedule` → creates a cron with a prompt describing the task
3. Every tick, the prompt fires and LLM decides what to do (exec, read, write, etc.)

## Storage

```sql
CREATE TABLE crons (
  name TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Control API

Settings UI talks to the agent via these endpoints:

- `GET /cron` — list all crons (name, prompt, cron, cronHuman, enabled, last_run, created_at)
- `PUT /cron/:name/enabled` — toggle enabled. Body: `{ enabled: true|false }`

## Implementation

- [x] `npm install cron-parser cronstrue` — parse expressions + human-readable descriptions
- [x] DB migration: `crons` table
- [x] Control API: `GET /cron`, `PUT /cron/:name/enabled`
- [x] `schedule` tool (create/pause/resume/delete)
- [x] Heartbeat cron check: scan due crons, push events to queue
- [x] Handle `cron:scheduled` events in main loop (feed prompt to LLM)
- [x] Unit tests
- [x] Integration test
