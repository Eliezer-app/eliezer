# Plan: Two-Table Compaction

## Problem

The current model overloads `context_content` on the messages table as a tri-state:
- `NULL` → flow zone (raw, uncompressed)
- `''` → skipped group member
- `'text'` → anchor with summary

This drives complex WHERE clauses and the `writeAnchors` / `findAnchorMessage` machinery
that resolves LLM output timestamps back to DB rows.

## Design

### Schema

```sql
-- Messages: raw data only
ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
-- Drop: context_content, archived_at

-- Compacted summaries: append-only
CREATE TABLE compacted (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,           -- 'user' | 'assistant'
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,  -- epoch, from source messages
  archived INTEGER NOT NULL DEFAULT 0
);
```

### Queries

| Zone | Query |
|------|-------|
| Flow zone (messages array) | `SELECT FROM messages WHERE NOT archived ORDER BY rowid` |
| Compacted history (system prompt) | `SELECT FROM compacted WHERE NOT archived ORDER BY id` |
| Compaction candidates | `SELECT FROM messages WHERE NOT archived` (group by time gaps) |

### Compaction flow

1. `identifyGroups()` — same time-gap logic, reads unarchived messages
2. LLM produces `{entries: [{time, role, summary}]}` — unchanged
3. `INSERT INTO compacted (role, summary, created_at)` — one row per entry
4. `UPDATE messages SET archived = 1 WHERE rowid BETWEEN ? AND ?` — mark source messages
5. Log to `compaction_log` — unchanged

No more `writeAnchors`, `findAnchorMessage`, or anchor deduplication.
The LLM output maps directly to INSERT rows.

### Distillation flow

1. Check compacted zone size (sum of summary lengths)
2. If over threshold: take oldest half of unarchived summaries
3. Feed to `distillToMemory()` — unchanged
4. `UPDATE compacted SET archived = 1 WHERE id <= ?`

### Context building

- `getCompactedHistory()`: `SELECT role, summary, created_at FROM compacted WHERE NOT archived ORDER BY id`
  → format as `[:timestamp] User/Agent: summary`
- `getContext()`: `SELECT FROM messages WHERE NOT archived ORDER BY rowid`
  → same as today minus the compacted zone

### Reset

```sql
UPDATE messages SET archived = 0;
DELETE FROM compacted;
```

### Migration

1. Create `compacted` table (empty)
2. Recreate `messages` table without `context_content` and `archived_at`, add `archived INTEGER NOT NULL DEFAULT 0`
3. Copy all rows from old messages (all conversations preserved, all unarchived)

Existing compacted summaries are discarded — re-compact to test the new flow.

## TODO: Separation of concerns

`memory.mts` and `compaction.mts` both read and write the same tables.
Schema is defined in `memory.mts`, but `compaction.mts` inserts into `compacted`,
updates `messages.archived`, and queries both tables directly.

**Target**: `compaction.mts` owns no DB state. It is a pure LLM compression engine:
format messages → call LLM → parse summaries. All DB reads and writes live in `memory.mts`.

- [ ] Move `writeCompacted()` to `memory.mts` (INSERT into compacted + UPDATE messages SET archived)
- [ ] Move `getCompactedSummaries()` to `memory.mts` (SELECT from compacted)
- [ ] Move `getUncompressedGroups()` / `identifyGroups()` to `memory.mts` (SELECT from messages)
- [ ] Move `getMemoryStats()` to `memory.mts` (SELECT from both tables)
- [ ] Move `distillToMemory()` DB write to `memory.mts` (memory.md write stays, archive logic moves to caller)
- [ ] Remove DB import from `compaction.mts` — pure LLM engine only

## Done

- [x] Schema: `compacted` table, `archived` column on messages, migration from old schema
- [x] Replace `writeAnchors` / `findAnchorMessage` with `writeCompacted` (INSERT into compacted + archive source messages)
- [x] Simplify `getCompactedSummaries` → query compacted table
- [x] Simplify `getUncompressedGroups` → `identifyGroups` filters `WHERE NOT archived` directly
- [x] Update `Memory.getCompactedHistory()` to read from compacted table
- [x] Update `Memory.getContext()` to use archived flag
- [x] Update `Memory.distill()` to archive compacted rows (not messages)
- [x] Update `Memory.buildPriorContext()` to read from compacted table
- [x] Update `getMemoryStats()` for new schema (drop `originalTokens`)
- [x] Update `tools.mts` `searchHistory` to search both tables
- [x] Update `server.mts` API docs (drop `originalTokens`)
- [x] Update `scripts/try-compaction.mts` to use production compaction path
- [x] Update `scripts/test-structured-compaction.mts` for new schema
- [x] Batch by content size (400k chars) instead of message count
- [x] Add debug logging to compaction pipeline (LLM calls, writes, batches, distillation)
- [x] Update tests
