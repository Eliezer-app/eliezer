# Plan: Debounced Agent State

## Problem

The heartbeat unconditionally sets `STATE_COMPACTION` on every tick, even when
compact()/distill() return null instantly (no work). The chat receives the state
change POST and briefly shows the "Compacting..." badge before the IDLE POST
arrives.

## Design

Two state variables:

- `agentState` — internal, updated immediately by `setAgentState()`, used by the agent loop
- `debouncedState` — public, updated after 100ms of stability, used by the chat (both POST and polling)

### setAgentState()

```typescript
let agentState: AgentState = STATE_IDLE;
let debouncedState: AgentState = STATE_IDLE;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function setAgentState(state: AgentState) {
    if (state === agentState) return;
    agentState = state;
    log.debug('state-change', { state });

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
        if (debouncedState === agentState) return;
        debouncedState = agentState;
        try { await chat.stateChange(debouncedState); }
        catch (e: any) { log.error('state-change post failed', { state: debouncedState, error: e.message }); }
    }, 100);
}
```

### Polling endpoint

`getState()` returns `debouncedState` instead of `agentState`:

```typescript
getState: () => ({
    currentEvent,
    state: debouncedState,
    queueDepth: queue.depth(),
    tokensUsed: llm.tokensUsed,
}),
```

### Behavior

- Transient states (COMPACTION that lasts <100ms) never reach the chat
- Sustained states (INFERENCE, TOOL_EXECUTION) appear after 100ms delay — imperceptible
- `setAgentState` is no longer async (no await needed at call sites), the POST fires from the timer callback
- No changes needed to compaction.mts or any other module

## Tasks

- [ ] Add `debouncedState` variable and debounce timer to `setAgentState()`
- [ ] Revert `setAgentState` to sync (remove await from call sites)
- [ ] Update `getState()` to return `debouncedState`
- [ ] Test: verify state-change integration test still passes
