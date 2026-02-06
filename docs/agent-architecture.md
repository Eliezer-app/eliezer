# Agent Architecture

## Port Layout

| Port | Service | Purpose |
|------|---------|---------|
| `:3100` | Chat server (`AGENT_PORT`) | Agent-facing API — eliezer calls this to send messages |
| `:3101` | Chat server (`PUBLIC_PORT`) | Public API — client calls this |
| `:3102` | Client dev server | Frontend (Vite dev) |
| `:3200` | Eliezer agent | Event receiver — chat server pushes events here |

## Files

```
eliezer.mts    — entry point: wire deps, run the loop
queue.mts      — EventQueue (SQLite-backed deferred-promise pop)
memory.mts     — Memory (SQLite-backed conversation context)
llm.mts        — LLMBase, AnthropicLLM, OpenAILLM, ContentBlock, Message
tools.mts      — Tool interface, exec/write/read/restart_self
chat.mts       — ChatClient, chat tool
server.mts     — HTTP server (POST /events, GET /health)
log.mts        — Logger (logfmt, levels, child loggers)
prompts/       — system.md, user.md, memory.md
```

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
│           │                                         │
│           ▼                                         │
│  ┌─────────────┐  ┌────────┐  ┌──────────┐        │
│  │  LLM Call   │→ │ Tools  │→ │ Memory   │        │
│  │ (Anthropic  │  │ (exec, │  │ (SQLite) │        │
│  │  or OpenAI) │  │  read, │  │          │        │
│  │             │  │  write,│  │          │        │
│  │             │  │  chat) │  │          │        │
│  └─────────────┘  └────────┘  └──────────┘        │
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

```typescript
while (true) {
  const event = await Promise.race([
    queue.pop(),           // wakes on new event
    sleep(HEARTBEAT_MS)    // wakes on timeout
  ]);

  if (!event) { queue.cancelWait(); continue; }

  await handleEvent(event);
  queue.done(event.id);
}
```

`handleEvent` runs the agentic tool loop:
1. Add event to memory
2. Call LLM with context + system prompt + tools
3. If LLM returns tool_use → execute tools → feed results back → repeat
4. If LLM returns text only → done

## LLM Providers

`LLM_PROVIDER` selects the implementation:
- `anthropic` → `AnthropicLLM` (native Anthropic API)
- `openai` → `OpenAILLM` (OpenAI-compatible: OpenAI, Groq, Ollama, etc. via `LLM_BASE_URL`)

Both normalize to internal `ContentBlock`/`Message` types. Token usage tracked via `LLMBase.tokensUsed`.

## Tools

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands |
| `read` | Read file contents |
| `write` | Write file contents |
| `chat` | Send/update/delete messages via chat server API |
| `restart_self` | Signal the loop to break (self-restart) |

## Prompts

Three files in `PROMPTS_DIR`, read fresh on each LLM call:
- `system.md` — agent identity, capabilities
- `user.md` — user-level instructions
- `memory.md` — persistent context

Assembled as: `system.md + user.md + "\n# Memory\n" + memory.md`

## Config

All env vars are required (validated at startup via `requireEnv()`):

| Var | Example | Description |
|-----|---------|-------------|
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `LLM_API_KEY` | | API key for the provider |
| `LLM_BASE_URL` | `https://api.anthropic.com` | Provider base URL |
| `LLM_MODEL` | `claude-sonnet-4-5-20250514` | Model identifier |
| `AGENT_PORT` | `3200` | HTTP server port |
| `DB_PATH` | `./state/eliezer.db` | SQLite database path |
| `CHAT_URL` | `http://localhost:3100` | Chat server agent API |
| `PROMPTS_DIR` | `./prompts` | Directory for prompt files |
| `HEARTBEAT_MS` | `30000` | Loop heartbeat interval |

## API

### POST /events

```json
{ "source": "chat", "type": "user_message", "payload": { "content": "Hello" } }
→ { "ok": true, "eventId": 1 }
```

### GET /health

```json
{ "status": "ok", "uptime": 3600, "queueDepth": 0, "tokensUsed": 1234 }
```

## Queue Persistence

SQLite-backed. Events survive crashes. Old `queue` table auto-migrated on startup.

```sql
CREATE TABLE event_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
