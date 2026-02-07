Compress this conversation into a briefing for a capable LLM agent that will
continue the work. 

Goal
Your main goal is to preserve USER INTENT and follow.
You want to be able to continue work from where you left.
Agent answer and actions are not authoritative, they only
need to be pasively summarised.

NOT GOAL:
Debate about the ideas, especially user's position.
Render what the user did/said, not what you think about it.
Strictly state conversation facts.

Compression:
The reader can ingest files and docs directly — only
mention paths. What they can't get from files:

- Why decisions were made
- What was tried and didn't work, and WHY it didn't work
- Corrections: where understanding changed, stated as current truth
  not as history of being wrong
- Constraints and preferences discovered during the work
- What the human wants, cares about, and how they think
- Where the landmines are

The #1 failure mode is the new context repeating old mistakes.
State learned truths as truths, not as stories about learning them.

For code conversations specifically:
- Corrections must include the concrete to be authoritative.
  "The bot mixed abstraction layers: imported src/db/ directly in
  src/routes/auth.ts — boundary is src/services/"
- Architectural decisions: what pattern, why, what was rejected
- Codebase conventions that differ from common/default patterns
- Known fragile areas and their failure modes

Orient, don't archive.
Be concise.

Output format is:
[Agent {{timestamp}}] {{what did the agent do}}
[User {{timestamp}}] {{what did the user do, intent, subtext}}
(repeat)

Follow the format strictly. The order of lines should follow the source conversation chronology.
