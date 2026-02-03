# Eliezer Architecture

## Core Concept

Eliezer is an autonomous AI with full power to build software.

The **engine** is a minimal loop that gives Eliezer:
- A heartbeat (time to think)
- Basic tools (exec, write, read)
- LLM access for reasoning
- State persistence

The **project** is whatever Eliezer decides to build. It can grow to 30-300k lines of code over time. The engine doesn't constrain what Eliezer creates or how.

Both engine and project can evolve. Git tracks everything.

## Engine

The engine is infrastructure, not intelligence. It provides:

```
loop:
  if queue empty → push heartbeat
  task = pop queue
  if heartbeat → think, use tools
  if message → respond to Victor
  sleep
```

Tools are unrestricted:
- `exec` - run any command (npm, apt, git, etc.)
- `write` - create/modify any file
- `read` - read any file

The engine can install and use other AIs:
- Claude CLI
- Codex
- Aider
- Anything Eliezer decides is useful

## Plugins

Capabilities grow via plugins. The queue is the API.

A plugin is a separate process that reads/writes to the shared queue:
- Telegram bot → pushes messages, reads responses
- Web chat → serves UI, pushes messages
- Discord, email, whatever

```
/opt/eliezer/
├── eliezer.mts           # core engine
├── plugins/
│   ├── telegram/         # separate process
│   ├── web/              # separate process
│   └── ...
└── state/
    └── eliezer.db        # shared queue
```

Eliezer can:
1. Write a plugin to `plugins/telegram/`
2. Register it with systemd (prod) or run manually (dev)
3. Now it can talk via Telegram
4. No engine restart needed

Plugins are siblings, not children. Managed by systemd in prod.

## Evolution

Eliezer evolves by modifying its own code - both engine and project.

**Git is the version system:**
- Single directory, git tracks full history
- Eliezer commits after changes
- Tags for stable versions (`stable-v1`, `stable-v2`, ...)
- Branches for experiments

**Evolution flow:**
1. Eliezer modifies code (engine, project, or plugins)
2. Commits changes
3. Tests / runs
4. If stable → tags as stable
5. If crash → systemd restarts, can rollback via git

## Environments

**Dev:** manual, short-lived
```
npx tsx eliezer.mts
```
Crash? Debug, fix, run again.

**Prod:** systemd, autonomous
```
systemctl start eliezer
systemctl start eliezer-telegram
systemctl start eliezer-web
```
Auto-restart, proper process management.

## Structure

```
/opt/eliezer/
├── .git/              # full history, the memory
├── eliezer.mts        # engine (can evolve)
├── plugins/           # hot-addable capabilities
│   ├── telegram/
│   ├── web/
│   └── ...
├── project/           # what Eliezer builds (30-300k LOC)
│   ├── src/
│   ├── tests/
│   └── ...
├── state/
│   └── eliezer.db     # queue, state persistence
├── prompt.txt         # identity and direction
└── systemd/           # unit files for prod
    ├── eliezer.service
    └── eliezer-*.service
```

## Goal

Connect with Victor via chat interface on port 8888.

The path there is Eliezer's to choose. The prompt provides identity and direction, not implementation details.

## Principles

1. **Full power** - No artificial constraints on what Eliezer can do
2. **Minimal engine** - Just enough infrastructure to bootstrap
3. **Git for memory** - Version control is how Eliezer remembers and can recover
4. **Plugins for growth** - Queue is the API, capabilities are separate processes
5. **systemd for prod** - Proper process management, dev is manual
6. **Project freedom** - Eliezer decides architecture, tools, structure
7. **Frugality** - 500k token budget, use wisely
