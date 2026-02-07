# Schedule Tool

`schedule` tool — LLM schedules recurring tasks via cron syntax.

## Usage

```
call({ name: "disk-check", command: "scripts/check-disk.sh", cron: "*/5 * * * *" })
call({ name: "disk-check", action: "pause" })
call({ name: "disk-check", action: "resume" })
call({ name: "disk-check", action: "delete" })
```

No `action` field = create. `command` and `cron` required for create only.

## How it works

- Schedules persist in SQLite (survive restarts)
- Heartbeat checks for due crons on each tick (cheap — scan table, compare timestamps)
- Due crons push events to the queue: `{ source: "cron", type: "scheduled", payload: { name, command } }`
- Normal event loop picks them up, feeds to LLM
- Crons always run. No global idle/active flag.

## "Think" prompt

The proactive idle behavior ("wake up and look around") is just another cron:

```
call({ name: "think", command: "__think__", cron: "*/5 * * * *" })
```

When fired, the event handler sends a think prompt to the LLM: "You have no pending events.
Check for outstanding tasks or do something useful."

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

1. LLM writes a script with `write`
2. `exec` → `chmod +x`
3. `schedule` → schedule it
4. LLM receives results as events, reacts if needed

## Storage

```sql
CREATE TABLE crons (
  name TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Depends on

- Cron expression parser (small lib or minimal subset implementation)
