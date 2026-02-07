# TODO

- [ ] **Resilience / Recovery**
  Crash handling, supervision (systemd, wrapper script), state save/rollback.
  Recover from git after catastrophic failure.

- [ ] **Agents**
  Sub-agents for complex tasks. Opus for architectural reasoning, Sonnet for execution.
  Specialized agents (code review, testing, research).

- [ ] **Plugin management**
  Plugin registry, auto-start on boot, health checks.

- [ ] **Budget management**
  Warn Victor when budget is low. Request increase, prioritize tasks by cost.

- [ ] **Multi-model**
  Route cheap tasks to cheap models, hard tasks to expensive ones.
  Agent chooses or hardcoded routing.

- [ ] **Compaction prompt**
  Switch to adversarially optimized compaction prompt.
  Test against edge cases, measure information retention.

- [ ] **Schedule policy**
  Define agent access/policy for enabling/disabling crons.
  What can the agent toggle on its own vs what requires user approval.

- [ ] **File/audio support**
  Handle file and audio attachments in chat messages.
  Pass to LLM as multimodal content.

- [ ] **File browser support**
  Browse and navigate files from the chat UI.

- [ ] **Eliezer's network**
  Opt-in: participate in a tightly curated conversation open to all Eliezer bots.

- [ ] **Search**
  Memory search, file search, web search.
  Semantic vs keyword. Embeddings.

- [ ] **App/widget development**
  Integrate app and widget development into the agent workflow.

- [ ] **Redact secrets**
  Redact secrets (API keys, tokens, credentials) from all tool results before storing in memory.

- [ ] **Security audit**
