import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import { compressGroup } from '../compaction.mts';
import { createLLM } from '../llm.mts';

const db = new Database(process.env.DB_PATH as string);
const memory = new Memory(db, process.env.USER_TZ as string);
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 120_000,
});

const groups = memory.getUncompressedGroups(60);
const group = groups[0];
const priorContext = memory.buildPriorContext(process.env.PROMPTS_DIR as string);

console.log(`Compressing group 0 (rowids ${group.start}-${group.end}, ${group.messages.length} msgs) with prior context...`);
console.log(`Prior context: ${priorContext ? Math.round(priorContext.length / 4) + ' tokens' : 'none'}`);
const result = await compressGroup(memory, group, llm, process.env.PROMPTS_DIR as string, process.env.USER_TZ as string, priorContext);
console.log(`\n=== Result: ${result.anchors} anchors, ${result.tokensBefore} → ${result.tokensAfter} tokens ===`);
const summaries = memory.getCompactedSummaries();
for (const s of summaries) console.log(`[${s.role}] ${s.summary}`);
