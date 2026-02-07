import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import { createLLM } from '../llm.mts';
import { getCompactedSummaries } from '../compaction.mts';

const db = new Database(process.env.DB_PATH as string);
const memory = new Memory(db);
memory.setCompactionConfig({
	tokenBudget: 80_000,
	groupGapSeconds: 60,
	flowLimitSeconds: 0,
	promptsDir: process.env.PROMPTS_DIR as string,
});
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 120_000,
});

console.log('Running compaction...');
const result = await memory.compact(llm);
console.log('Result:', result);

const summaries = getCompactedSummaries(db);
console.log(`\n--- ${summaries.length} compacted summaries ---`);
summaries.forEach((s, i) => console.log(`\n=== Summary ${i + 1} ===\n${s}`));
