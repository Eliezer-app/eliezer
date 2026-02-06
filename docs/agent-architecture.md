# Agent Architecture

> This document describes the assumed agent architecture. The agent is a separate project, but the chat server is designed to integrate with it as a plugin.

## Port Layout

| Port | Service | Purpose |
|------|---------|---------|
| `:3100` | Chat server (`AGENT_PORT`) | Agent-facing API — eliezer calls this to send messages, etc. |
| `:3101` | Chat server (`PUBLIC_PORT`) | Public API — client calls this |
| `:3102` | Client dev server | Frontend (Vite dev) |
| `:3200` | Eliezer agent | Event receiver — chat server pushes events here via `AGENT_URL` |

## Overview

```
┌─────────────────────────────────────────────────────┐
│                   AGENT (:3200)                     │
│                                                     │
│  POST /events    ←── receives from all plugins     │
│  GET /health     ←── monitoring                    │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │            Event Queue + Loop               │   │
│  │   await Promise.race([queue, timeout])      │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
        ▲                              │
        │ events                       │ actions
        │                              ▼
┌───────┴───────┐  ┌─────────┐  ┌─────────────┐
│  Chat Server  │  │  Files  │  │  Webhooks   │  ...
│ (:3100/:3101) │  │ Plugin  │  │   Plugin    │
└───────────────┘  └─────────┘  └─────────────┘
```

## Agent Loop

The agent runs a single event loop using `Promise.race` for efficient wake-up:

```typescript
while (true) {
  const event = await Promise.race([
    queue.pop(),      // wakes on new event
    sleep(30_000)     // wakes on timeout (heartbeat)
  ]);

  if (event) {
    await handleEvent(event);
  }

  await heartbeat();
}
```

This pattern is similar to Go's `select` statement - the loop sleeps until either:
- A new event arrives (from any plugin)
- The timeout expires (periodic tasks)

## Agent API

### POST /events

Receive events from plugins.

```typescript
interface AgentEvent {
  source: string;      // plugin identifier: "chat", "files", "webhook", etc.
  type: string;        // event type within that source
  payload: unknown;    // event-specific data
  timestamp?: string;  // ISO 8601, defaults to now
}
```

Example:
```json
{
  "source": "chat",
  "type": "user_message",
  "payload": {
    "conversationId": "default",
    "messageId": "abc-123",
    "content": "Hello agent!"
  }
}
```

Response:
```json
{ "ok": true, "eventId": "evt_xyz" }
```

### GET /health

Health check endpoint.

```json
{ "status": "ok", "uptime": 3600, "queueDepth": 0 }
```

## Event Types by Source

### Chat Plugin (`source: "chat"`)

| Type | Payload | Description |
|------|---------|-------------|
| `user_message` | `{ conversationId, messageId, content }` | User sent a message |
| `message_deleted` | `{ conversationId, messageId }` | User deleted a message |
| `widget_error` | `{ conversationId, appId, error }` | Widget reported an error |
| `app_action` | `{ conversationId, appId, action, payload }` | Widget requested an action |

### Files Plugin (`source: "files"`)

| Type | Payload | Description |
|------|---------|-------------|
| `file_changed` | `{ path, changeType }` | File was modified |
| `file_created` | `{ path }` | File was created |
| `file_deleted` | `{ path }` | File was deleted |

### Webhook Plugin (`source: "webhook"`)

| Type | Payload | Description |
|------|---------|-------------|
| `github_push` | `{ repo, branch, commits }` | GitHub push event |
| `github_pr` | `{ repo, action, pr }` | GitHub PR event |

## Plugin Action APIs

Plugins expose APIs for the agent to perform actions.

### Chat Server Actions

Base URL: `http://localhost:3100/api/agent`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/send` | POST | Send a message |
| `/upload` | POST | Send a message with attachment |
| `/messages/:id` | PATCH | Update a message |
| `/messages/:id` | DELETE | Delete a message |
| `/app-state/:convId/:appId` | POST | Update widget state |

### Files Plugin Actions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/read` | POST | Read file contents |
| `/write` | POST | Write file contents |
| `/exec` | POST | Execute command |

## Process Isolation

The agent runs as a **separate process** from plugins. This is intentional:

1. **Self-modification safety**: Agent edits its own code. If it breaks itself, it shouldn't take down the chat server.

2. **Independent restarts**: Chat server can restart (e.g., code changes via tsx watch) without killing the agent mid-task.

3. **Plugin isolation**: A buggy plugin doesn't crash the agent.

## Queue Persistence

The agent uses SQLite as a durable event queue:

- Events are persisted before acknowledgment
- If agent crashes, unprocessed events survive
- Enables replay/debugging of event history

```sql
CREATE TABLE event_queue (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,  -- JSON
  status TEXT DEFAULT 'pending',  -- pending, processing, done, failed
  created_at TEXT NOT NULL,
  processed_at TEXT
);
```

## Chat Server Integration

The chat server (this project) integrates as a plugin:

1. **Sends events** to agent when users interact
2. **Exposes action API** for agent to respond
3. **Maintains own state** (messages, sessions, app state)

### Configuration

Chat server environment variables (from its docker-compose):
```bash
AGENT_PORT=3100         # Port for agent-facing API
PUBLIC_PORT=3101        # Port for public API (client-facing)
AGENT_URL=http://127.0.0.1:3200  # Where to push events to the agent
```

Agent environment variables:
```bash
AGENT_PORT=3200                    # Port the agent listens on for events
CHAT_URL=http://127.0.0.1:3100    # Chat server's agent API
```

When `AGENT_URL` is not set on the chat server, notifications are silently skipped (agent not running).

### Implementation

Events are sent via fire-and-forget POST to `${AGENT_URL}/events`:
- Failures are silently ignored (agent may be down)
- Response is not awaited (non-blocking)

See `server/src/index.ts` for the `notifyAgent()` function and event triggers.
