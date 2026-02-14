import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { Memory, estimateTokens } from '../memory.mts';
import { compressGroups } from '../compaction.mts';
import { createLLM } from '../llm.mts';

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

// --- get messages to compress ---
const allGroups = memory.getUncompressedGroups(60);
if (allGroups.length < 2) { console.log('Not enough groups to compress'); process.exit(0); }
const toCompress = allGroups.slice(0, -1);
const allMessages = toCompress.flatMap(g => g.messages);
const tokensBefore = allMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
console.log(`${allGroups.length} groups, compressing ${toCompress.length} (${allMessages.length} messages, ~${tokensBefore} tokens)\n`);

// --- run actual production compaction ---
console.log('--- Calling compressGroups (production path) ---\n');
const result = await compressGroups(memory, toCompress, llm, PROMPTS_DIR, process.env.USER_TZ as string);
console.log(`Result: ${result.anchors} anchors, ${result.messages} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens (${(result.tokensAfter / result.tokensBefore * 100).toFixed(1)}%)\n`);

// --- read results from DB ---
const summaries = memory.getCompactedSummaries();

console.log('='.repeat(80));
console.log('COMPACTED SUMMARIES');
console.log('='.repeat(80));

for (const s of summaries) {
	const ts = new Date(s.created_at * 1000).toISOString().slice(0, 19);
	const role = s.role === 'assistant' ? 'agent' : 'user';
	console.log(`\n[${role}] time=${ts}`);
	console.log(`  ${s.summary}`);
}

const archivedCount = (db.prepare('SELECT count(*) as count FROM messages WHERE archived').get() as { count: number }).count;
console.log('\n' + '='.repeat(80));
console.log(`${summaries.length} summaries, ${archivedCount}/${allMessages.length} messages archived`);
