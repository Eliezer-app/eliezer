import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import {
	identifyGroups, estimateTokens, compressGroup, getCompactedSummaries,
	getUncompressedGroups, archiveGroups, getMemoryStats, Group,
} from '../compaction.mts';

function createDb(): Database.Database {
	const db = new Database(':memory:');
	new Memory(db); // runs migrations
	return db;
}

function insertMessage(db: Database.Database, role: string, content: string, createdAt: number, id?: string) {
	db.prepare(
		'INSERT INTO messages (chat_message_id, role, content, created_at) VALUES (?, ?, ?, ?)'
	).run(id ?? crypto.randomUUID(), role, content, createdAt);
}

// Fake LLM that returns a predictable summary
const fakeLlm = {
	tokensUsed: 0,
	tokenLimit: 500_000,
	hasBudget() { return true; },
	async call(messages: any[]) {
		return {
			content: [{ type: 'text' as const, text: `Summary of ${messages[0].content.split('\n').length} messages` }],
			stop_reason: 'end_turn',
		};
	},
} as any;

describe('identifyGroups', () => {
	it('groups messages within time gap', () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		insertMessage(db, 'user', 'msg3', t + 10);

		const groups = identifyGroups(db, 60);
		expect(groups).toHaveLength(1);
		expect(groups[0].messages).toHaveLength(3);
	});

	it('splits on time gap', () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		// 2 minute gap
		insertMessage(db, 'user', 'msg3', t + 125);
		insertMessage(db, 'assistant', 'msg4', t + 130);

		const groups = identifyGroups(db, 60);
		expect(groups).toHaveLength(2);
		expect(groups[0].messages).toHaveLength(2);
		expect(groups[1].messages).toHaveLength(2);
	});

	it('returns empty for empty db', () => {
		const db = createDb();
		expect(identifyGroups(db, 60)).toHaveLength(0);
	});

	it('single message is one group', () => {
		const db = createDb();
		insertMessage(db, 'user', 'solo', 1000000);
		const groups = identifyGroups(db, 60);
		expect(groups).toHaveLength(1);
		expect(groups[0].messages).toHaveLength(1);
	});
});

describe('estimateTokens', () => {
	it('estimates ~4 chars per token', () => {
		expect(estimateTokens('hello world')).toBe(3); // 11 / 4 = 2.75 → 3
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('a'.repeat(400))).toBe(100);
	});
});

describe('compressGroup', () => {
	it('sets context_content on anchor and empties others', async () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'hello', t, 'msg1');
		insertMessage(db, 'assistant', 'world', t + 5, 'msg2');

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);

		const rows = db.prepare('SELECT chat_message_id, context_content FROM messages ORDER BY rowid').all() as any[];
		expect(rows[0].context_content).toBe('');
		expect(rows[1].context_content).toContain('Summary');
	});

	it('logs to compaction_log', async () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'hello', t);
		insertMessage(db, 'assistant', 'world', t + 5);

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);

		const log = db.prepare('SELECT * FROM compaction_log').all() as any[];
		expect(log).toHaveLength(1);
		expect(log[0].op).toBe('compress');
		expect(log[0].tokens_before).toBeGreaterThan(0);
		expect(log[0].tokens_after).toBeGreaterThan(0);
	});
});

describe('getCompactedSummaries', () => {
	it('returns only non-empty, non-archived summaries', async () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		// gap
		insertMessage(db, 'user', 'msg3', t + 200);
		insertMessage(db, 'assistant', 'msg4', t + 205);

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);
		await compressGroup(db, groups[1], fakeLlm);

		const summaries = getCompactedSummaries(db);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]).toContain('Summary');
	});
});

describe('getUncompressedGroups', () => {
	it('excludes already compressed groups', async () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		// gap
		insertMessage(db, 'user', 'msg3', t + 200);

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);

		const uncompressed = getUncompressedGroups(db, 60);
		expect(uncompressed).toHaveLength(1);
		expect(uncompressed[0].messages[0].content).toBe('msg3');
	});
});

describe('archiveGroups', () => {
	it('sets archived_at and logs', async () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);
		archiveGroups(db, groups);

		const rows = db.prepare('SELECT archived_at FROM messages').all() as any[];
		expect(rows.every((r: any) => r.archived_at !== null)).toBe(true);

		const log = db.prepare("SELECT * FROM compaction_log WHERE op = 'archive'").all();
		expect(log).toHaveLength(1);
	});

	it('archived groups excluded from compacted summaries', async () => {
		const db = createDb();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);
		expect(getCompactedSummaries(db)).toHaveLength(1);

		archiveGroups(db, groups);
		expect(getCompactedSummaries(db)).toHaveLength(0);
	});
});

describe('getMemoryStats', () => {
	it('returns correct zone counts', async () => {
		const db = createDb();
		const t = 1000000;
		// Flow zone: 2 messages
		insertMessage(db, 'user', 'flow1', t);
		insertMessage(db, 'assistant', 'flow2', t + 5);
		// gap
		insertMessage(db, 'user', 'old1', t + 200);
		insertMessage(db, 'assistant', 'old2', t + 205);

		const groups = identifyGroups(db, 60);
		await compressGroup(db, groups[0], fakeLlm);

		const stats = getMemoryStats(db, '/nonexistent/memory.md', 80000, 500, 100);
		expect(stats.context.flow.messages).toBe(2);
		expect(stats.context.compacted.groups).toBeGreaterThanOrEqual(1);
		expect(stats.archived.messages).toBe(0);
		expect(stats.context.budget).toBe(80000);
		expect(stats.context.total.pct).toBeGreaterThanOrEqual(0);
	});
});
