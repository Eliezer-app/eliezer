import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { getUncompressedGroups, getCompactedSummaries, summarizeGroup } from '../compaction.mts';
import { createLLM } from '../llm.mts';

const db = new Database(process.env.DB_PATH as string);
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 120_000,
});

const groups = getUncompressedGroups(db, 60);
const group = groups[0];

// Build prior context
const parts: string[] = [];
let mem = '';
try { mem = readFileSync(process.env.PROMPTS_DIR + '/memory.md', 'utf-8').trim(); } catch {}
if (mem) parts.push('## Memory\n' + mem);
const summaries = getCompactedSummaries(db);
if (summaries.length) parts.push('## Compacted history\n' + summaries.join('\n\n'));
const priorContext = parts.length ? parts.join('\n\n') : undefined;

console.log(`Compressing group 0 (rowids ${group.start}-${group.end}, ${group.messages.length} msgs) with prior context...`);
console.log(`Prior context: ${priorContext ? Math.round(priorContext.length / 4) + ' tokens' : 'none'}`);
const summary = await summarizeGroup(group, llm, process.env.PROMPTS_DIR as string, priorContext);
console.log('\n=== Result ===\n' + summary);
