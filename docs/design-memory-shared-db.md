# Memory & Context Design — Shared SQLite

## Concept

Agent and chat server share a single SQLite database file (WAL mode). Both processes read/write directly. No API calls for message sync. Separate processes, shared state.

## Schema Ownership

**Chat server owns:**
- `messages` — user messages, agent replies, visible in UI
- `conversations` — conversation metadata
- Any other chat-specific tables

**Agent owns:**
- `tool_history` — tool calls, tool results, internal loop state (not visible in chat)
- `event_queue` — incoming events
- `agent_metadata` — compaction marks, relevance flags, summaries (keyed by message ID)

Both read from each other's tables. Writes are scoped to owned tables.

## Context Building

1. Read recent messages from `messages` table (chat-owned, always fresh)
2. Read tool history from `tool_history` table (agent-owned)
3. Read compaction metadata from `agent_metadata` table
4. Interleave by timestamp
5. Apply compaction: skip irrelevant messages, use summaries where available
6. Trim to context window limit

## Deletion

User deletes a message in chat UI → row removed from `messages` table. Agent sees it immediately on next context build. No events, no sync, no orphans.

Agent metadata for deleted messages becomes dead weight — cleaned up lazily on next context build (join misses).

## Compaction

Agent reads messages, decides what's relevant, writes metadata to `agent_metadata`:

```sql
CREATE TABLE agent_metadata (
  message_id TEXT PRIMARY KEY,  -- references messages.id
  summary TEXT,
  relevant BOOLEAN DEFAULT 1,
  compacted_at INTEGER
);
```

Chat server ignores this table. Agent owns the schema and the process.

## Deployment

Both containers mount the same SQLite file:

```yaml
services:
  chat:
    volumes:
      - ./state/shared.db:/data/shared.db

  eliezer:
    volumes:
      - ./state/shared.db:/data/shared.db
```

SQLite WAL mode enabled on first connection. Concurrent reads are lock-free. Writes acquire a brief file-level lock — negligible at this scale.

## Trade-offs

**Pros:**
- No sync problem — single source of truth
- No API calls between services for data access
- Deletions are instant and consistent
- Simple to reason about

**Cons:**
- Schema coupling — both services must agree on table structure
- SQLite file must be on a shared volume (not across network)
- Write contention possible at high throughput (unlikely at current scale)
- Both processes must use compatible SQLite versions

## vs. API Variant (design-memory-api.md)

The API variant keeps databases separate and syncs via HTTP. Cleaner service boundaries but introduces sync problems (agent down during deletion, stale data, orphan entries). The shared DB variant trades service purity for consistency.
