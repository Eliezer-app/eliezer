# What's Next

## Resilience / Recovery
- What happens when eliezer.mts crashes? Currently just dies
- Options: systemd in prod, wrapper script, or self-healing in code
- Server.mts (plugins) also need supervision
- Consider: save state before risky operations, rollback on failure

## Memory Compaction
- Currently: last 100 messages, no compaction
- TODO: LLM-based summarization of old context
- Keep full history in DB, but send compressed context to API
- Maybe: separate "working memory" vs "long-term memory"

## Agents?
- Could Eliezer spawn sub-agents for complex tasks?
- Opus for architectural reasoning, Sonnet for execution
- Or: specialized agents (code review, testing, research)
- Risk: complexity, cost, coordination

## Other Ideas

### Response channel
- Currently Eliezer processes tasks but can't reply directly
- Chat UI polls or websocket?
- Add response table or use existing messages table

### Plugin management
- Eliezer creates plugins ad-hoc (server.mts, chat UI)
- Should there be a registry? Auto-start on boot?
- Plugin health checks

### Security
- Eliezer has full shell access - intentional but risky
- Credentials visible in env (leaked in first exploration)
- Sandboxing options?

### Persistence across restarts
- mount/ is wiped on clean - Eliezer's work disappears
- Option: commit Eliezer's changes to git?
- Or: separate "ephemeral" vs "permanent" directories

### Budget management
- Currently just stops thinking when budget exhausted
- Could: warn Victor, request budget increase, prioritize tasks

### Multi-model
- Use cheap model for simple tasks, expensive for hard ones
- Eliezer chooses? Or hardcoded routing?

### Context bounds
- Currently: last 100 messages, no size check
- Large tool outputs (file reads) can blow up context
- Need: truncation, pagination, or smart summarization
- Consider: max tokens per message, max total context

### Max message size
- Tool outputs can be huge (e.g., reading a large file)
- Should truncate or chunk before storing/sending
- Warn Eliezer when output was truncated

### Long-term memory / notes to self
- Persistent knowledge that survives context compaction
- "I learned that...", "Remember to...", "Victor prefers..."
- Separate table or file? Injected into system prompt?
- Eliezer writes notes, retrieves relevant ones per task

### Search
- Memory search: find relevant past conversations/tasks
- File search: grep, glob across codebase
- Web search: research, docs, stack overflow
- Semantic vs keyword? Embeddings?
