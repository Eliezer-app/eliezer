/**
 * Dry-run compaction on a specific range of messages.
 * Usage: npx tsx scripts/recompact.mts <from_rowid> <to_rowid>
 *
 * Exercises the real compressGroups code path (including batching),
 * then rolls back so no DB changes persist.
 */
import { config } from 'dotenv';
config();
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import { compressGroups } from '../compaction.mts';
import { createLLM } from '../llm.mts';
import { parseDuration } from '../tools.mts';

const from = parseInt(process.argv[2]);
const to = parseInt(process.argv[3]);
if (!from || !to || from > to) {
	console.error('Usage: npx tsx scripts/recompact.mts <from_rowid> <to_rowid>');
	process.exit(1);
}

const DB_PATH = process.env.DB_PATH as string;
const PROMPTS_DIR = process.env.PROMPTS_DIR as string;
const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW);

const GROUP_GAP = parseDuration(
	(process.env.COMPACTION_GROUP_GAP_INTERVAL || process.env.COMPACTION_GROUP_GAP) as string
);
if (!GROUP_GAP) { console.error('Missing COMPACTION_GROUP_GAP_INTERVAL'); process.exit(1); }

const USER_TZ = process.env.USER_TZ as string;
const db = new Database(DB_PATH);
const memory = new Memory(db, USER_TZ);
const llm = createLLM({
	provider: (process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER) as string,
	apiKey: (process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY) as string,
	model: (process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL) as string,
	baseUrl: (process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL) as string,
	timeoutMs: 240_000,
	maxTokens: 25_000,
});

const groups = memory.identifyGroups(GROUP_GAP, { includeArchived: true, fromRowid: from, toRowid: to });

if (!groups.length) {
	console.error(`No messages found in rowid range ${from}-${to}`);
	process.exit(1);
}

const messages = groups.flatMap(g => g.messages);
const tokens = messages.reduce((sum, m) => sum + memory.messageTokens(m), 0);
console.log(`Messages: ${messages.length}, tokens: ${tokens}, groups: ${groups.length}`);

for (let i = 0; i < groups.length; i++) {
	const g = groups[i];
	const gTokens = g.messages.reduce((sum, m) => sum + memory.messageTokens(m), 0);
	console.log(`  group ${i + 1}: rowid ${g.start}-${g.end}, ${g.messages.length} messages, ${gTokens} tokens`);
}

console.log('\nCompressing...');
db.exec('BEGIN');
try {
	const result = await compressGroups(memory, groups, llm, PROMPTS_DIR, 'recompact script', CONTEXT_WINDOW);
	console.log(`\nResult: ${result.tokensBefore} -> ${result.tokensAfter} tokens, ${result.anchors} batches`);

	// Print what was written to compacted table
	const rows = db.prepare('SELECT summary FROM compacted WHERE NOT archived ORDER BY id').all() as Array<{ summary: string }>;
	for (const r of rows) {
		console.log('\n---\n' + r.summary);
	}
} finally {
	db.exec('ROLLBACK');
}
