import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { createLLM } from '../llm.mts';
import { Memory } from '../memory.mts';
import { Compactor } from '../compaction.mts';

const db = new Database(process.env.DB_PATH as string);
const memory = new Memory(db, process.env.USER_TZ as string);
const PROMPTS_DIR = process.env.PROMPTS_DIR as string;
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 240_000,
});
// Set budget to 1 so the 90% threshold is always exceeded
const compactor = new Compactor(memory, llm, process.env.USER_TZ as string, {
	tokenBudget: 1,
	groupGapSeconds: 60,
	flowLimitSeconds: 0,
	promptsDir: PROMPTS_DIR,
});

const groups = memory.getUncompressedGroups(60);
console.log(`${groups.length} uncompressed groups`);
if (groups.length < 2) { console.log('Need at least 2 groups'); process.exit(0); }
console.log(`Oldest group: rowids ${groups[0].start}-${groups[0].end}, ${groups[0].messages.length} messages\n`);

console.log('--- Calling compactTail (emergency compaction) ---\n');
const cp = compactor.prepare();
if (!cp) { console.log('prepare returned null'); process.exit(1); }
const result = await compactor.compactTail(cp);
if (!result) { console.log('compactTail returned null'); process.exit(1); }
console.log(`Result: ${result.anchors} anchors, ${result.messages} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens (${(result.tokensAfter / result.tokensBefore * 100).toFixed(1)}%)\n`);

// Show what landed in DB
const summaries = memory.getCompactedSummaries();
console.log('='.repeat(80));
console.log(`COMPACTED SUMMARIES (${summaries.length})`);
console.log('='.repeat(80));
for (const s of summaries) {
	console.log(`\n[${s.role}] ${s.summary}`);
}

// Show remaining uncompressed
const remaining = memory.getUncompressedGroups(60);
console.log(`\n${remaining.length} uncompressed groups remaining`);
