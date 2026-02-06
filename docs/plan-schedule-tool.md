# Schedule Tool (Phase 2)

`ScheduleActionTool` — LLM schedules recurring commands via cron syntax.

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
- Heartbeat checks for due actions on each tick
- Results pushed as events: `{ source: "schedule", type: "action_result", payload: { name, output } }`
- Normal event loop picks them up, feeds to LLM

## Typical workflow

1. LLM writes a script with `WriteTool`
2. `ExecTool` → `chmod +x`
3. `ScheduleActionTool` → schedule it
4. LLM receives results as events, reacts if needed

## Depends on

- Cron expression parser (small lib or minimal subset implementation)
- Idle/active mode via settings event (so heartbeat always ticks)
