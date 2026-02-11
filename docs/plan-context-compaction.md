# Plan: Context Compaction

## Problem

The agent uses a sliding window of the last 100 messages for LLM context.
Tool loops burn through this fast — a single read→edit is 4 messages.
User requests and decisions fall off before tool noise does.

## Design

### Three-tier memory model

```
System prompt:
┌─────────────────────────────────────────────┐
│  Instructions (system.md)                   │  Static.
├─────────────────────────────────────────────┤
│  Memory (memory.md)                         │  Permanent. Distilled facts,
│  "user prefers tabs", "API is at /send"     │  preferences, architecture.
├─────────────────────────────────────────────┤
│  Compacted history                          │  Timestamped LLM-generated summaries.
│  "[10:32] Read config.mts, edited DB init"  │  Oldest first.
└─────────────────────────────────────────────┘

Messages:
┌─────────────────────────────────────────────┐
│  Flow zone                                  │  Raw messages. Full detail.
│  Recent messages, reasoning included.       │  Agent's working memory.
└─────────────────────────────────────────────┘
```

Flow: **flow zone → compacted history (system prompt) → memory.md → archived**

- New messages enter the flow zone (messages array)
- When idle, oldest flow messages roll into compacted history (timestamped summaries in system prompt)
- When compacted history overflows, oldest summaries are distilled into memory.md, then archived
- Archived groups leave the context window but stay in DB (raw + summaries, searchable)

### Storage

Add a `context_content` column to the messages table (nullable TEXT):

```sql
ALTER TABLE messages ADD COLUMN context_content TEXT;
```

Add an `archived_at` column (nullable DATETIME) for distilled groups:

```sql
ALTER TABLE messages ADD COLUMN archived_at DATETIME;
```

Semantics when building context (`getContext()`):
- `archived_at` is set → skip (distilled into memory.md, out of context)
- `context_content IS NULL` → hot zone, use raw `content`
- `context_content = ''` → skip (member of a compressed group)
- `context_content` has text → compacted zone, use as summary

Both `content` and `context_content` are write-once, never modified after being set.
Nothing is ever deleted from DB. The full message history (raw + summaries) remains
searchable regardless of what's in the active context window.

### Groups (time-based)

Groups are detected by **time gaps** between messages. If the gap between two
consecutive messages exceeds `COMPACTION_GROUP_GAP` (default: 1 minute), that's a group boundary.

- Messages seconds apart → same group (tool loops, rapid exchanges)
- Messages minutes apart → different groups (new task, user returned)

No need to parse message structure. One comparison: `created_at[i+1] - created_at[i] > groupGap`.

### Compression (hot → compacted)

LLM-generated summaries. Each chunk is summarized independently (cost is per-token,
not per-call, so fine to split).

Uses a dedicated **summarization LLM instance** — can be a cheaper/faster model
(e.g. Haiku, GPT-4o-mini). Configured via optional env vars:

- `COMPACTION_LLM_PROVIDER` (falls back to `LLM_PROVIDER`)
- `COMPACTION_LLM_API_KEY` (falls back to `LLM_API_KEY`)
- `COMPACTION_LLM_BASE_URL` (falls back to `LLM_BASE_URL`)
- `COMPACTION_LLM_MODEL` (falls back to `LLM_MODEL`)
- `COMPACTION_GROUP_GAP` — time gap to split messages into groups (default: `1m`)
- `COMPACTION_FLOW_LIMIT` — minimum age before a group can be compacted (default: `1m`). Protects the current flow state from compression.

If none are set, uses the main model. This keeps costs low for the bulk of
compression work while allowing the main model to stay expensive/capable.

What gets compressed:
- **File read results** → LLM summarizes the code structure
- **Exec output** → LLM summarizes what the command returned
- **Assistant reasoning** → dropped entirely (only needed for provider replay in hot zone)
- **Tool call + result pairs** → compact to action + outcome
- **Edit/write calls** → unified diff format (old/new from the tool input)

Summary is stored on the group's anchor message (last in group, `context_content = summary`).
All other messages in the group get `context_content = ''` (skipped).

### Distillation (compacted → memory.md)

When the compacted zone overflows, the oldest summaries are fed to the LLM with:

```
Here are old conversation summaries about to be dropped.
Extract any facts worth remembering permanently:
- User preferences and decisions
- Architecture and design choices
- Codebase patterns and conventions
- External service details (URLs, APIs, credentials shape)

Current memory.md:
<contents>

Summaries being dropped:
<oldest summaries>

Output the updated memory.md.
```

The LLM merges new insights into the existing memory.md, deduplicates, and removes
anything outdated. The result is written back to `prompts/memory.md`.

After distillation, the group is marked as archived (separate flag — `context_content`
is never modified once set). Archived summaries stay in DB and remain searchable.

### Triggers

Two modes:

```
on heartbeat (every HEARTBEAT_MS):
  if flow zone > 1/3 budget:
    find oldest uncompressed group where
      age > COMPACTION_FLOW_LIMIT
    if found: compress it
    (repeat next heartbeat if still over)

on event processing (before each LLM call):
  if flow zone > 90% budget:
    compress oldest uncompressed group (no flow check — forced)
  proceed normally
```

**Heartbeat compression**: runs on every tick. Cheap check (one SQL query), only
calls the LLM when there's actually something to compress. Respects
`COMPACTION_FLOW_LIMIT` — won't compress a group the agent is still in flow on.
Target: bring flow zone down to 1/3 of budget.

**Emergency compression**: reactive. Only when flow zone hits 90% of budget during
active processing. Skips the flow limit — when forced, compress regardless.
Better to lose some context fidelity than to exceed the window.

### Context building

`getContext()` builds the LLM API call:

```
System prompt:
  1. Instructions (system.md)
  2. Memory (memory.md)

Messages:
  3. Compacted history as role-correct messages:
     SELECT role, context_content, created_at FROM messages
       WHERE context_content IS NOT NULL
         AND context_content != ''
         AND archived_at IS NULL
       ORDER BY rowid
     → each injected as {role, content: "[timestamp+offset] summary"}
     → consecutive same-role merged
  4. Flow zone (raw messages):
     SELECT role, content, created_at FROM messages
       WHERE context_content IS NULL
         AND archived_at IS NULL
       ORDER BY rowid
     → each prefixed with [timestamp+offset]
     → consecutive same-role merged
```

Compacted summaries are injected as real conversation messages with correct roles
(user decisions come from user-role messages, agent actions from assistant-role).
The structured compaction output includes role per entry; `findAnchorMessage` is
role-aware so each summary lands on a DB row matching its role.

Timestamps use the user's timezone (`USER_TZ` env var) formatted as ISO 8601 with
offset (e.g. `2026-02-06T08:46-08:00`).

Compression is NOT triggered by getContext(). It runs separately:
- From the heartbeat loop (every tick)
- From handleEvent before each LLM call (emergency check)

### Token budget

Configured via `CONTEXT_WINDOW` env var (default: 200k for Claude, 250k for Kimi K2).
- Idle target: flow zone ≤ 1/3 of budget
- Emergency threshold: 90% of budget

Steady-state layout of the context window:
```
│  system.md + memory.md       │  ~5k tokens (fixed)
│  compacted history           │  fills available space
│  flow zone                   │  ~1/3 budget (uncompressed)
```

### Observability

#### Status table

```sql
CREATE TABLE compaction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,           -- 'compress' | 'distill' | 'archive'
  group_start INTEGER,        -- first rowid in group
  group_end INTEGER,          -- last rowid in group
  tokens_before INTEGER,
  tokens_after INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Logs each compaction operation with before/after token counts. Enables tracking
compression ratio, frequency, and timing.

#### `/info/memory` endpoint

Returns live stats queried directly from the messages table + compaction_log:

```json
{
  "zones": {
    "flow":      { "messages": 42, "tokens": 18200 },
    "compacted": { "messages": 8,  "tokens": 5400,  "groups": 3 },
    "archived":  { "messages": 156, "tokens": null,  "groups": 12 }
  },
  "memory_md_size": 1240,
  "budget": { "total": 80000, "used": 28840, "pct": 36 },
  "last_compression": "2025-05-14T10:32:00Z",
  "last_distillation": "2025-05-14T09:15:00Z",
  "compressions_24h": 14,
  "distillations_24h": 2
}
```

Queries:
- Zone counts/sizes: `GROUP BY` on `context_content` / `archived_at` states
- Last ops / counts: from `compaction_log`
- Memory.md size: `stat` on file

### History search

A `search_history` tool lets the agent query past conversations that have fallen
out of context. Searches raw `content` across all messages regardless of compaction state.

```
search_history({ query: "friday meeting about API" })
→ matches with timestamps, role, and snippet
```

Enables recall: "what did you tell me on Friday about X?" — the agent searches,
finds the relevant messages, and answers from the raw record.

## Implementation

### Phase 1: Engine (no runtime behavior change)

Build and test the compression pipeline. Agent keeps working as before.

- [x] DB migrations: `context_content`, `archived_at`, `compaction_log` columns/table
- [x] Compaction LLM instance (separate `COMPACTION_LLM_*` config, falls back to main)
- [x] Time-based group detection: `identifyGroups(gapSeconds)` → array of rowid ranges
- [x] Token estimator: `estimateTokens()` → number
- [x] Structured compaction: LLM produces `{entries: [{time, role, summary}, ...]}` with JSON mode
- [x] Role-aware anchor matching: `findAnchorMessage(time, role, messages)` prefers matching role
- [x] `compressGroup(group)` / `compressGroups(groups)` — calls LLM, writes anchors to DB
- [x] Distiller: `distillToMemory(summaries, currentMemory, llm)` → string
- [x] `compaction_log` logging in compress/distill ops
- [x] `/info/memory` endpoint
- [x] `search_message_history` tool (AND-matched parts across raw content + summaries)
- [x] Unit tests for all of the above

Validate: run compression on real messages, inspect summaries, tune prompts.

### Phase 2: Run compaction (no context change)

Wire triggers into heartbeat/event loop. Compaction runs and writes to DB,
but `getContext()` still uses the old 100-message sliding window.
Observable via `/info/memory`.

- [x] Idle compression in heartbeat loop
- [x] Emergency compression in handleEvent
- [x] Parse `COMPACTION_GROUP_GAP` and `COMPACTION_FLOW_LIMIT` env vars

### Phase 3: Use compacted context (runtime behavior change)

Flip `getContext()` to the new layout. Agent starts using compacted history.

- [x] Update `getContext()` — compacted summaries as role-correct messages, flow zone after
- [x] Consecutive same-role message merging (compacted + flow zones)
- [x] Timestamps on all messages (`USER_TZ`-aware with offset)
- [x] `USER_TZ` env var for timezone configuration
- [x] JSON mode (`response_format: { type: 'json_object' }`) for compaction LLM
- [x] Format instructions in user message (not system) for Kimi K2.5 compliance
- [x] Dynamic entry count hint in compaction prompt
- [ ] Integration tests
