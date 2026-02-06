# Memory & Context Design — API Variant

Chat server owns the messages DB. Agent accesses messages via HTTP API. Each service has its own database.

## Two Stores

**Chat DB** (owned by chat server, accessed via API):
- `messages` table — user messages, agent replies, everything visible in UI
- Agent metadata field (opaque JSON) on each message row — written by agent via `PATCH /messages/:id`
- Chat server stores the metadata but doesn't interpret it

**Agent DB** (local SQLite, private to agent):
- `tool_history` — tool calls, tool results, internal loop state
- `event_queue` — incoming events

## Context Building

1. `GET /messages` from chat server — always fresh, no stale data
2. Read tool history from local `tool_history` table
3. Interleave by timestamp
4. Apply compaction: check metadata on each message, skip irrelevant, use summaries
5. Trim to context window limit

## Compaction

Agent owns the compaction process. It reads messages from chat via API, decides what's relevant, writes metadata back via `PATCH /messages/:id`:

```json
{
  "agentMeta": {
    "compacted": true,
    "summary": "User asked about deployment, agent provided docker instructions",
    "relevant": false
  }
}
```

Chat server stores `agentMeta` opaquely — it doesn't interpret the contents. The agent owns this schema.

## Deletion

- User deletes in chat UI → row gone from chat DB, including agent metadata
- Agent sees it immediately on next `GET /messages` — no orphan references
- No sync events needed for deletions
- Tool history in agent DB is self-contained, never references chat message IDs

## Deployment

Separate containers, separate databases, HTTP between them:

```yaml
services:
  chat:
    volumes:
      - ./state/chat.db:/data/chat.db

  eliezer:
    volumes:
      - ./state/agent.db:/data/agent.db
    environment:
      CHAT_URL: http://chat:3100
```

## Trade-offs

**Pros:**
- Clean service boundaries — no schema coupling
- Each service owns its DB exclusively
- Chat server can swap storage (Postgres, etc.) without affecting agent
- No shared filesystem required

**Cons:**
- HTTP latency on every context build (`GET /messages`)
- Agent must be online to read messages (no offline access)
- `PATCH /messages/:id` for metadata requires chat server to support opaque fields
- More moving parts than shared DB

## Current Implementation

Temporary: agent stores all messages locally in SQLite `messages` table with `chat_message_id` for delete sync via events. This will be replaced when the chat server supports the `agentMeta` field on messages.
