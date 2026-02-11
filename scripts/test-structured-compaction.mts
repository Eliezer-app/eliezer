import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { getUncompressedGroups, compressGroups, estimateTokens, MessageRow } from '../compaction.mts';
import { createLLM } from '../llm.mts';

const db = new Database(process.env.DB_PATH as string);
const PROMPTS_DIR = process.env.PROMPTS_DIR as string;
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 240_000,
});

// --- get messages to compress ---
const allGroups = getUncompressedGroups(db, 60);
if (allGroups.length < 2) { console.log('Not enough groups to compress'); process.exit(0); }
const toCompress = allGroups.slice(0, -1);
const allMessages = toCompress.flatMap(g => g.messages);
const tokensBefore = allMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
console.log(`${allGroups.length} groups, compressing ${toCompress.length} (${allMessages.length} messages, ~${tokensBefore} tokens)\n`);

// --- run actual production compaction ---
console.log('--- Calling compressGroups (production path) ---\n');
const result = await compressGroups(db, toCompress, llm, PROMPTS_DIR, process.env.USER_TZ as string);
console.log(`Result: ${result.anchors} anchors, ${result.messages} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens (${(result.tokensAfter / result.tokensBefore * 100).toFixed(1)}%)\n`);

// --- read results from DB ---
const rows = db.prepare(
	`SELECT rowid, role, context_content, created_at FROM messages
	 WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`,
).all(allMessages[0].rowid, allMessages[allMessages.length - 1].rowid) as
	Array<{ rowid: number; role: string; context_content: string | null; created_at: number }>;

console.log('='.repeat(80));
console.log('ANCHOR MAP (from DB)');
console.log('='.repeat(80));

let anchors = 0;
let skipped = 0;
for (const r of rows) {
	if (r.context_content === null) continue; // untouched (shouldn't happen)
	if (r.context_content === '') { skipped++; continue; }
	anchors++;
	const ts = new Date(r.created_at * 1000).toISOString().slice(0, 19);
	const role = r.role === 'assistant' ? 'agent' : 'user';
	console.log(`\n[${role}] rowid=${r.rowid} time=${ts}`);
	console.log(`  ${r.context_content}`);
}

console.log('\n' + '='.repeat(80));
console.log(`${anchors} anchors, ${skipped} skipped, ${anchors + skipped}/${allMessages.length} messages processed`);
