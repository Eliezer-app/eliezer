# TODO

- [ ] **File browser support**
  Browse and navigate files from the chat UI.

- [ ] **Agents**
  Sub-agents for complex tasks. Opus for architectural reasoning, Sonnet for execution.
  Specialized agents (code review, testing, research).

- [ ] **Budget management**
  Warn Victor when budget is low. Request increase, prioritize tasks by cost.

- [ ] **Multi-model**
  Route cheap tasks to cheap models, hard tasks to expensive ones.
  Agent chooses or hardcoded routing.

- [ ] **Eliezer's network**
  Opt-in: participate in a tightly curated conversation open to all Eliezer bots.

- [ ] **Audio transcription**
  Transcribe audio attachments via Groq Whisper API (fast, cheap, OpenAI-compatible).
  Pass transcript to LLM as text content.

- [ ] **Security audit**

# Done

- [x] **Compaction prompt**
  Switch to adversarially optimized compaction prompt.
  Test against edge cases, measure information retention.

- [x] **Redact secrets**
  Redact secrets (API keys, tokens, credentials) from all tool results before storing in memory.

- [x] **Prompt placeholders**
  Replace placeholders in prompts at runtime, e.g. `{{APP_DIR}}` → `/app`.

- [x] **File upload support**
  Handle file and image attachments in chat messages.
  Pass to LLM as multimodal content.
