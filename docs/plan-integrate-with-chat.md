# Chat Integration Plan

Rewrite eliezer as a multi-file ESM TypeScript project integrated with the clawchat server.

## Ports

- `:3100` — Chat server agent API (`CHAT_URL`, eliezer calls this)
- `:3200` — Eliezer event receiver (`AGENT_PORT`, chat server pushes here)

## Files and Classes

```
eliezer.mts    — entry point: wire deps, run the loop
queue.mts      — EventQueue, AgentEvent
memory.mts     — Memory
llm.mts        — LLMBase, AnthropicLLM, OpenAILLM, ContentBlock, Message
tools.mts      — ToolBase, ToolResult, ExecTool, WriteTool, ReadTool, RestartSelfTool
chat.mts       — ChatClient, ChatTool
server.mts     — startServer()
log.mts        — Logger
prompts/       — system.md, user.md, memory.md (shared with chat server)
```

**Two base classes:**
- `ToolBase` — `name`, `describe()`, error-wrapped `call()`. Each tool is a subclass.
- `LLMBase` — `call(messages, system, tools)`. Normalizes provider responses to internal types.

**Concrete LLM implementations:**
- `AnthropicLLM` — Anthropic API format
- `OpenAILLM` — OpenAI-compatible (OpenAI, Moonshot, Groq, Ollama, etc. via `baseUrl`)

For integration tests, a mock HTTP server implements one of the real provider shapes. No test-only code in the agent.

**Dependencies (one-way, no cycles):**
```
eliezer.mts
  ├── server.mts   → queue.mts
  ├── queue.mts     → log.mts
  ├── memory.mts    → llm.mts (ContentBlock, Message types)
  ├── llm.mts       → log.mts
  ├── tools.mts     → log.mts
  ├── chat.mts      → tools.mts (extends ToolBase)
  └── log.mts       → (standalone)
```

## Module Details

### `log.mts`
Logger with logfmt output to stdout. Supports levels: `error`, `info`, `debug`. Child loggers via `.with({module: 'Name'}, level)` for per-module level overrides. Config: `LOG_LEVEL` (default), `LOG_LEVELS` (per-module, e.g. `WriteTool:debug,LLM:debug`).

### `queue.mts`
`EventQueue`: SQLite-backed with deferred-promise `pop()`. `push()` persists AND wakes the waiting `pop()`. `cancelWait()` clears a dangling waiter. Migrates old `queue` table on startup.

### `memory.mts`
`Memory`: conversation context from SQLite `messages` table. Unchanged from current, just extracted.

### `llm.mts`
`LLMBase`: base class. `call(messages, system, tools)` → `{content, stop_reason}`. Owns `ContentBlock` and `Message` types. Token counter built in (`tokensUsed`, `tokenLimit`, `hasBudget()`).

`AnthropicLLM extends LLMBase`: Anthropic API format. Constructor takes `apiKey`, `model`.

`OpenAILLM extends LLMBase`: OpenAI-compatible format. Constructor takes `apiKey`, `model`, `baseUrl`. Translates between OpenAI chat/completions shape and internal `ContentBlock`/`Message` types.

Config picks the class: `LLM_PROVIDER=anthropic|openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.

### `tools.mts`
`ToolBase`: `name`, `describe()`, `call()` with error boundary.

Concrete tools: `ExecTool`, `WriteTool`, `ReadTool`, `RestartSelfTool`.

`RestartSelfTool` returns a signal via `ToolResult.signal` — the caller handles it.

### `chat.mts`
`ChatClient`: HTTP client to clawchat at `:3100`. Methods: `send()`, `updateMessage()`, `deleteMessage()`, `updateAppState()`.

`ChatTool extends ToolBase`: takes `ChatClient`, wraps it as a tool the LLM can invoke.

### `server.mts`
`startServer(port, queue, getHealth)`: HTTP server with `POST /events` and `GET /health`.

### `eliezer.mts`
Entry point. Wires everything:
1. Load env
2. Open SQLite
3. Init state table (key-value in SQLite), instantiate: Logger, Memory, EventQueue, LLM (from `LLM_PROVIDER` config), ChatClient, all tools
4. Start HTTP server
5. Run the main loop (`Promise.race` between `queue.pop()` and heartbeat timeout)

## Main Loop

```typescript
const HEARTBEAT_INTERVAL = 30_000;

while (running) {
  const popPromise = queue.pop();
  const event = await Promise.race([popPromise, sleep(HEARTBEAT_INTERVAL).then(() => undefined)]);

  if (!event) queue.cancelWait();

  if (event) {
    await handleEvent(event);
    queue.done(event.id);
  } else if (mode === MODE_ACTIVE) {
    await handleThink();
  }
}
```

`mode` persisted in SQLite via `state.get('mode', 'idle')` on startup. Updated by `handleEvent` when it receives a `settings:mode_changed` event.

## Prompts

Three files in `PROMPTS_DIR`, shared with the chat server (editable via settings UI):

- `system.md` — agent identity, capabilities, tool descriptions
- `user.md` — user-level instructions, preferences
- `memory.md` — persistent context injected into the prompt

System prompt assembled on each LLM call: `system.md` + `user.md` + `\n# Memory\n` + `memory.md`. Edits take effect immediately, no restart.

## Config

### `docker-compose.yml`
- Port: `8888:8888` → `3200:3200`
- Add env: `CHAT_URL`, `AGENT_PORT=3200`

### `Makefile`
- `@cp *.mts credentials.env package.json package-lock.json mount/`
- `@cp -r prompts mount/`

### `credentials.env.example`
```
AGENT_PORT=3200
CHAT_URL=http://localhost:3100
PROMPTS_DIR=./prompts
LLM_PROVIDER=anthropic
LLM_BASE_URL=https://api.anthropic.com
LLM_API_KEY=
LLM_MODEL=claude-sonnet-4-5-20250514
LOG_LEVEL=info
LOG_LEVELS=
```

## Verification

1. `npm run dev` → agent starts, HTTP on :3200
2. `curl localhost:3200/health` → status JSON
3. POST event to :3200/events → agent wakes, calls LLM, uses `chat` tool to respond via :3100
4. Full integration: clawchat + eliezer, end-to-end message flow

## Tasks

### Phase 1 — Mock LLM & test foundation
- [ ] Mock LLM server (OpenAI-compatible HTTP server, canned responses)
- [ ] `log.mts` — Logger with logfmt, levels, child loggers

### Phase 2 — Minimal loop (end-to-end against mock)
- [ ] `llm.mts` — LLMBase, OpenAILLM (test against mock first)
- [ ] `queue.mts` — EventQueue with deferred-promise pop, SQLite schema
- [ ] `server.mts` — HTTP server with POST /events and GET /health
- [ ] `eliezer.mts` — entry point, wiring, bare main loop (no tools, no chat)
- [ ] Verify: post event → agent calls mock LLM → logs response

### Phase 3 — Integration test harness
- [ ] Test script: starts mock LLM, starts agent, posts event, asserts LLM was called
- [ ] CI-friendly (exit codes, timeout)

### Phase 4 — Tools
- [ ] `tools.mts` — ToolBase, ExecTool, WriteTool, ReadTool, RestartSelfTool
- [ ] Wire tools into the loop (LLM calls tools, results fed back)
- [ ] Verify: mock LLM returns tool_use → agent executes → result fed back to LLM

### Phase 5 — Chat integration
- [ ] `chat.mts` — ChatClient, ChatTool
- [ ] Wire ChatTool into tools array
- [ ] Verify: mock LLM returns chat tool_use → agent calls chat server API

### Phase 6 — Memory & prompts
- [ ] `memory.mts` — extract Memory class, wire into loop
- [ ] `prompts/` — system.md, user.md, memory.md
- [ ] Prompt assembly (system + user + memory)

### Phase 7 — AnthropicLLM & config
- [ ] `llm.mts` — AnthropicLLM (second provider)
- [ ] `credentials.env.example` — all config vars
- [ ] LLM_PROVIDER config switch in entry point

### Phase 8 — Deployment
- [ ] `docker-compose.yml` — update ports and env
- [ ] `Makefile` — update run target
- [ ] Old queue migration in EventQueue
- [ ] `docs/agent-architecture.md` — update with final architecture
- [ ] Full integration: clawchat + eliezer end-to-end
