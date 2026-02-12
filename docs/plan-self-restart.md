# Self-Restart Notification Implementation

## Summary

Fix `restart_self` to trigger automatic systemd restart and immediately notify the agent that a restart occurred.

## Changes

### 1. systemd service

Change `Restart=on-failure` to `Restart=always`:

```ini
[Service]
Type=simple
Restart=always
RestartSec=5
```

### 2. eliezer.mts

**Imports:** Add `writeFileSync`, `unlinkSync`, `existsSync` from 'fs'

**Constant:**
```typescript
const RESTART_FLAG_FILE = `${DB_PATH}.restart-flag`;
```

**Startup check (after init, before main loop):**
```typescript
if (existsSync(RESTART_FLAG_FILE)) {
  unlinkSync(RESTART_FLAG_FILE);
  queue.push('system', 'restart', { message: 'You just restarted' });
}
```

**On restart request (main loop, after handleEvent returns 'restart'):**
```typescript
writeFileSync(RESTART_FLAG_FILE, '');
break;
```

## Flow

1. `restart_self` tool returns `signal: 'restart'` → `handleEvent` returns `'restart'` → flag file written → main loop breaks → process exits cleanly
2. Systemd `Restart=always` triggers restart after 5s
3. New process: flag found → deleted → synthetic event pushed to queue
4. Main loop wakes immediately, processes event, agent responds

## Why Queue

`memory.add()` doesn't wake the blocked loop (agent waits on `queue.pop()`). `queue.push()` wakes it immediately so the agent processes autonomously.

## Note on tsx caching

If changes don't take effect, clear esbuild cache: `rm -rf node_modules/.cache/esbuild`
