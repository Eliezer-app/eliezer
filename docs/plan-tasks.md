# Plan: Task List and Continuations

## Context

Eliezer is a generalist personal agent. The surface area is large but context is limited. Currently the agent is purely reactive — it processes events and goes idle. We want the agent to maintain a persistent task list and continue working on tasks when idle, enabling multi-step work that spans sessions.

The task list is hierarchical (parent/child). Only the agent manages it (create, update, complete). The user can view tasks read-only through a chat settings panel.

## Design

### DB Table

Single table, adjacency list for hierarchy:

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES tasks(id),
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_work, done
    priority INTEGER NOT NULL DEFAULT 0,     -- lower = higher priority, global ordering
    due_date TEXT,                           -- ISO 8601, nullable
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`title` is short (shows in tree), `details` is what the agent reads when picking up work. `due_date` is nullable — agent reasons about urgency, no automatic sorting by due date. Priority is global (flat integer).

### Task Manager

New file `tasks.mts`. Class `TaskManager` owns the DB table and provides methods:

```
constructor(db)           — creates table
create(title, details?, parentId?, priority?, dueDate?)  — insert, returns id
update(id, fields)        — update any field
complete(id)              — set status = 'done'
delete(id)                — delete task
list()                    — all non-done tasks as flat array with parent_id
tree()                    — non-done tasks as nested tree (for display/API)
pending()                 — pending/in_work tasks ordered by priority (for continuation)
lastMessageAge(db)        — seconds since last message in messages table
```

Pattern: follows `CronManager` in `cron.mts` — constructor takes `db`, creates table, exposes methods.

### Task Tool

The agent manages tasks through a tool. Added to the tools array in `eliezer.mts`.

Tool name: `task`
Actions: `create`, `update`, `list`, `complete`, `delete`

Class `TaskTool extends ToolBase` in `tasks.mts` (same file as TaskManager — tightly coupled). Constructor takes `TaskManager`.

### Continuation Trigger

Uses the same idle detection as compaction: the heartbeat path in the main loop (eliezer.mts:203-214) fires when `sleep(HEARTBEAT_MS)` wins the race against `queue.pop()`.

After heartbeat, check two conditions:
1. Are there pending tasks?
2. Is the agent idle? (last message age > threshold)

```typescript
if (!event) {
    queue.cancelWait();
    currentEvent = null;
    await heartbeat();
    // Continuation: idle + pending tasks
    const pending = taskManager.pending();
    if (pending.length && taskManager.lastMessageAge() > CONTINUATION_IDLE_SEC) {
        queue.push('system', 'continue_work', {});
    }
    continue;
}
```

`lastMessageAge()` queries `SELECT MAX(created_at) FROM messages` — the same messages table the memory system uses. This naturally resets when the agent does anything (continuation itself produces messages).

For `continue_work` events, format the task list as a user message:

```typescript
if (event.source === 'system' && event.type === 'continue_work') {
    const tasks = taskManager.pending();
    const taskList = tasks.map(t => `- [${t.id}] (p${t.priority}) ${t.title}`).join('\n');
    memory.add('user', `[continue work]\nPending tasks:\n${taskList}`);
}
```

The agent decides what to pick up, or does nothing.

### System Prompt Section

Similar to how crons are shown in `getSystem()` (eliezer.mts:89-95), add a tasks section showing non-done tasks as an indented tree. Gives the agent awareness on every turn.

### REST Endpoint

`GET /tasks` — returns the task tree for the chat settings panel (read-only).

Added to `server.mts` via `ServerDeps.listTasks`. Returns `taskManager.tree()`.

## Phase 2 (not in scope)

- **GC of done tasks**: synthetic task triggered when `doneTasks.length > 50` — agent cleans up its own done tasks.

## Files to modify

1. **`tasks.mts`** (new) — `TaskManager` class + `TaskTool extends ToolBase`
2. **`eliezer.mts`** — instantiate TaskManager + TaskTool, add to tools array, continuation logic in idle path, task section in `getSystem()`
3. **`server.mts`** — add `GET /tasks` endpoint, add `listTasks` to `ServerDeps`
4. **`prompts-default/system.md`** — mention task tool briefly

## Execution order

1. Create `tasks.mts` with `TaskManager` and `TaskTool`
2. Wire into `eliezer.mts`: instantiate, add tool, add system prompt section
3. Add continuation logic to the idle path
4. Add `GET /tasks` to `server.mts`
5. Add task tool mention to system prompt
6. Write tests in `test/tasks.test.mts`
7. `make test`

## Verification

- `make test` — all tests pass
- `npx tsc --noEmit` — no type errors
- Manual: agent can create/list/complete tasks via tool
- Manual: idle agent picks up pending tasks
- `GET /tasks` returns tree structure
