import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import { createLLM } from '../llm.mts';
import { identifyGroups, compressGroups, getCompactedSummaries } from '../compaction.mts';

const db = new Database(process.env.DB_PATH as string);
new Memory(db, process.env.USER_TZ as string); // ensure tables exist
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 240_000,
});

const allGroups = identifyGroups(db, 60, true);
if (allGroups.length < 2) { console.log('Not enough groups to compress'); process.exit(0); }
const toCompress = allGroups.slice(0, -1);
const allMessages = toCompress.flatMap(g => g.messages);
const totalChars = allMessages.reduce((sum, m) => sum + m.content.length, 0);
console.log(`${allGroups.length} groups, compressing ${toCompress.length} (${allMessages.length} messages, ${totalChars} chars)\n`);

const result = await compressGroups(db, toCompress, llm, process.env.PROMPTS_DIR as string, process.env.USER_TZ as string);
console.log(`Result: ${result.anchors} summaries, ${result.messages} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens (${(result.tokensAfter / result.tokensBefore * 100).toFixed(1)}%)\n`);

const summaries = getCompactedSummaries(db);
console.log(`--- ${summaries.length} compacted summaries ---`);
for (const s of summaries) {
	const ts = new Date(s.created_at * 1000).toISOString().slice(0, 19);
	console.log(`\n[${s.role === 'assistant' ? 'agent' : 'user'}] ${ts}`);
	console.log(`  ${s.summary}`);
}
