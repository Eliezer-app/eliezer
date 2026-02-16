Curate this conversation into a briefing for a capable LLM agent that will
continue the work. 

## Goal 1
Your main goal is to preserve USER INTENT and follow.
You want to be able to continue work from where you left.

Read the user's intent between the lines.
What did the user say about it?
Reproduce them in the output either as quotes, or succint pointers.
Agent has extensive capabilities to be useful.
It wants to discover paths to help the user.


Record the user reaction to agent's action.
Your rendering of the story must answer the question: what did the user say about it?
Example:
Agent did|made...
User said "pretty good" | "that's rad!" | "never do that" | "that's unacceptable"
Use quotes.

Focus is on what did the agent good from user's perspective.
What the agent should avoid doing.

## Goal 2
Preserve the history of what happend, without overflowing the context window.

## Rules
Agent answer and actions are not authoritative, they only
need to be pasively summarised.

Preserve:
- Key reactions from user. Even if short, some are very relevant.
- Why decisions that were made
- What was tried and didn't work, and WHY it didn't work
- Corrections: where understanding changed, stated as current truth
  not as history of being wrong
- Constraints and preferences discovered during the work
- What the human wants, cares about, and how they think
- Where the landmines are

The #1 failure mode is the new context repeating old mistakes.
State learned truths as truths, not as stories about learning them.

For code exchanges and tool uses:
- preserve all coordonates like: file paths, ports, URLs
- preserve edits to files: summarise changes
- Corrections must include the concrete to be authoritative.
  "The bot mixed abstraction layers: imported src/db/ directly in
  src/routes/auth.ts — boundary is src/services/"
- Architectural decisions: what pattern, why, what was rejected
- Codebase conventions that differ from common/default patterns
- Known fragile areas and their failure modes

Orient, don't archive.
Curate, don't summarize.
Quote directly when words carry tone. Don't paraphrase emotion preserve it.
Same with code, technical facts. Select the important and keep it in.
Only reduce the input size by ~ a factor of 3.

Follow and convey the conversation chronology.
You might need to remember both what and when.
Include timestamps to record the time dimension of the conversation.
Example:
[2026-02-06T23:18-08:00] User: "-prompt from the user-"
[2026-02-06T23:18-08:00] Agent did -action- | said -agent reply-
[2026-02-06T23:20-08:00] User: "-quote reaction from user-"

In the example:
- IMPORTANT! who did what?
- IMPORTANT! what was user's reaction?

It's required for questions like, "when did we talk about...?".

Be precise who's thought or action you note, agent or user.

**Ouptut format:**

[<timestamp>] <user-action-or-quote>
[<timestamp>] <agent-action-or-answer>
[<timestamp>] <user-reaction> <- this one is always IMPORTANT
...

## File changes
<file-path> - <summary-of-change> <reason-of-change>
...

## Notes
  ### <section>
    - <important-fact>
    ...
  ...



