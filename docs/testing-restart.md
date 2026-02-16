# Manual restart flow test

Tests the full restart cycle: LLM calls restart tool → agent exits → agent restarts → picks up restart event.

## Setup

```bash
docker compose -f docker-compose.test.yml up -d
# Wait for agent to be healthy
sleep 3
docker logs eliezer-test-agent-1 2>&1 | tail -3
```

## Step 1: Configure mock LLM to call restart tool

```bash
curl -s http://localhost:9999/next-tool \
  -d '{"name":"restart_self","arguments":{}}' \
  -H 'Content-Type: application/json'
```

## Step 2: Send a user message to trigger the LLM

```bash
curl -s http://localhost:3200/events \
  -d '{"source":"chat","type":"user_message","payload":{"conversationId":"default","messageId":"test-restart","content":"please restart yourself"}}' \
  -H 'Content-Type: application/json'
```

## Step 3: Verify agent exited

```bash
sleep 3
docker ps -a --filter name=eliezer-test-agent --format "{{.Status}}"
# Expected: Exited (0) ...
```

Check logs for the restart sequence:

```bash
docker logs eliezer-test-agent-1 2>&1 | grep -E "tool:restart_self|restart requested"
# Expected:
#   tool:restart_self input={}
#   tool:restart_self result=ok
#   restart requested — exiting
```

## Step 4: Restart agent (simulates systemd restart)

```bash
docker start eliezer-test-agent-1
sleep 3
```

## Step 5: Verify restart event was processed

```bash
docker logs eliezer-test-agent-1 --since 10s 2>&1 | grep -E "handling event|restart"
# Expected:
#   handling event source=system type=restart
```

Verify chat received the restart thought:

```bash
curl -s http://localhost:4100/calls | python3 -m json.tool
# Should include: {"content": "You just restarted", "type": "thought"}
```

## Teardown

```bash
docker compose -f docker-compose.test.yml down
```
