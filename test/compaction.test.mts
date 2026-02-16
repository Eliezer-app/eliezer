import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Memory, estimateTokens, Group } from '../memory.mts';
import { compressGroup } from '../compaction.mts';

function createMemory(): { db: Database.Database; memory: Memory } {
	const db = new Database(':memory:');
	const memory = new Memory(db, 'UTC');
	return { db, memory };
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
			content: [{ type: 'text' as const, text: 'Summary of messages' }],
			stop_reason: 'end_turn',
		};
	},
} as any;

describe('identifyGroups', () => {
	it('groups messages within time gap', () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		insertMessage(db, 'user', 'msg3', t + 10);

		const groups = memory.identifyGroups(60);
		expect(groups).toHaveLength(1);
		expect(groups[0].messages).toHaveLength(3);
	});

	it('splits on time gap', () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		// 2 minute gap
		insertMessage(db, 'user', 'msg3', t + 125);
		insertMessage(db, 'assistant', 'msg4', t + 130);

		const groups = memory.identifyGroups(60);
		expect(groups).toHaveLength(2);
		expect(groups[0].messages).toHaveLength(2);
		expect(groups[1].messages).toHaveLength(2);
	});

	it('returns empty for empty db', () => {
		const { memory } = createMemory();
		expect(memory.identifyGroups(60)).toHaveLength(0);
	});

	it('single message is one group', () => {
		const { db, memory } = createMemory();
		insertMessage(db, 'user', 'solo', 1000000);
		const groups = memory.identifyGroups(60);
		expect(groups).toHaveLength(1);
		expect(groups[0].messages).toHaveLength(1);
	});

	it('excludes archived messages', () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		db.prepare('UPDATE messages SET archived = 1').run();
		insertMessage(db, 'user', 'msg3', t + 200);

		const groups = memory.identifyGroups(60);
		expect(groups).toHaveLength(1);
		expect(groups[0].messages).toHaveLength(1);
		expect(groups[0].messages[0].content).toBe('msg3');
	});
});

describe('estimateTokens', () => {
	it('counts tokens via tiktoken', () => {
		expect(estimateTokens('hello world')).toBe(2);
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(0);
	});
});

describe('compressGroup', () => {
	it('archives source messages and inserts into compacted table', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'hello', t, 'msg1');
		insertMessage(db, 'assistant', 'world', t + 5, 'msg2');

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);

		// Source messages should be archived
		const msgs = db.prepare('SELECT chat_message_id, archived FROM messages ORDER BY rowid').all() as any[];
		expect(msgs.every((m: any) => m.archived === 1)).toBe(true);

		// Compacted table should have one summary row
		const compacted = db.prepare('SELECT role, summary FROM compacted').all() as any[];
		expect(compacted).toHaveLength(1);
		expect(compacted[0].summary).toBe('Summary of messages');
		expect(compacted[0].role).toBe('assistant');
	});

	it('logs to compaction_log', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'hello', t);
		insertMessage(db, 'assistant', 'world', t + 5);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);

		const log = db.prepare('SELECT * FROM compaction_log').all() as any[];
		expect(log).toHaveLength(1);
		expect(log[0].op).toBe('compress');
		expect(log[0].tokens_before).toBeGreaterThan(0);
		expect(log[0].tokens_after).toBeGreaterThan(0);
	});
});

describe('getCompactedSummaries', () => {
	it('returns non-archived summaries from compacted table', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		// gap
		insertMessage(db, 'user', 'msg3', t + 200);
		insertMessage(db, 'assistant', 'msg4', t + 205);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);
		// Second group now becomes the only unarchived group
		const groups2 = memory.identifyGroups(60);
		await compressGroup(memory, groups2[0], fakeLlm, 'prompts-default', 'test', 250000);

		const summaries = memory.getCompactedSummaries();
		expect(summaries).toHaveLength(2);
		expect(summaries[0].summary).toContain('Summary');
	});

	it('excludes archived summaries', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);
		expect(memory.getCompactedSummaries()).toHaveLength(1);

		db.prepare('UPDATE compacted SET archived = 1').run();
		expect(memory.getCompactedSummaries()).toHaveLength(0);
	});
});

describe('getUncompressedGroups', () => {
	it('excludes already compressed groups', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'msg1', t);
		insertMessage(db, 'assistant', 'msg2', t + 5);
		// gap
		insertMessage(db, 'user', 'msg3', t + 200);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);

		const uncompressed = memory.getUncompressedGroups(60);
		expect(uncompressed).toHaveLength(1);
		expect(uncompressed[0].messages[0].content).toBe('msg3');
	});
});

describe('getCompactedHistory', () => {
	it('returns formatted text block for system prompt', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'hello', t);
		insertMessage(db, 'assistant', 'world', t + 5);
		// gap
		insertMessage(db, 'user', 'second', t + 200);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);

		const history = memory.getCompactedHistory();
		expect(history).toContain('Summary of messages');
	});

	it('returns empty string when nothing is compacted', () => {
		const { db, memory } = createMemory();
		insertMessage(db, 'user', 'hello', 1000000);

		expect(memory.getCompactedHistory()).toBe('');
	});

	it('compacted messages excluded from getContext()', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		insertMessage(db, 'user', 'old msg', t);
		insertMessage(db, 'assistant', 'old reply', t + 5);
		// gap
		insertMessage(db, 'user', 'recent msg', t + 200);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);

		const context = memory.getContext();
		const allText = context.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
		expect(allText).toContain('recent msg');
		expect(allText).not.toContain('old msg');
	});
});

describe('getMemoryStats', () => {
	it('returns correct zone counts', async () => {
		const { db, memory } = createMemory();
		const t = 1000000;
		// Flow zone: 2 messages
		insertMessage(db, 'user', 'flow1', t);
		insertMessage(db, 'assistant', 'flow2', t + 5);
		// gap
		insertMessage(db, 'user', 'old1', t + 200);
		insertMessage(db, 'assistant', 'old2', t + 205);

		const groups = memory.identifyGroups(60);
		await compressGroup(memory, groups[0], fakeLlm, 'prompts-default', 'test', 250000);

		const stats = memory.getMemoryStats('/nonexistent/memory.md', 80000, 'system prompt text', 'memory text');
		expect(stats.context.flow.messages).toBe(2);
		expect(stats.context.compacted.groups).toBeGreaterThanOrEqual(1);
		expect(stats.archived.messages).toBe(2);
		expect(stats.context.budget).toBe(80000);
		expect(stats.context.total.pct).toBeGreaterThanOrEqual(0);
	});
});
