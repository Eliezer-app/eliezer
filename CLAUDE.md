Act as a senior SWE with deep understanding of SOLID principles. Be pragmatic and apply solutions that match the task at hand, don't overengineer. Clean code should generally mean LESS code.

Validate all env vars and throw (exit program) if they are not configured.

## Testing

Run tests with `make test` — it starts Docker containers (mock LLM, mock chat, agent), runs vitest, then tears down. Don't run `npx vitest` directly — integration tests need the services.
