import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { encoding_for_model } from 'tiktoken';
import { ContentBlock, Message } from './llm.mts';
import { Logger } from './log.mts';

const enc = encoding_for_model('gpt-4o');

const log = new Logger({ module: 'Memory' });

// --- Types ---

export interface MessageRow {
	rowid: number;
	chat_message_id: string;
	role: string;
	content: string;
	created_at: number;
	archived: number;
	tokens: number | null;
}

export interface Group {
	start: number; // first rowid
	end: number;   // last rowid
	messages: MessageRow[];
}

// --- Pure utilities ---

/**
 * Count tokens using tiktoken (cl200k_base, GPT-4o encoding).
 */
export function estimateTokens(text: string): number {
	return enc.encode(text).length;
}

/**
 * Format epoch seconds as ISO 8601 with timezone offset.
 * e.g. 2026-02-06T08:46-08:00
 */
export function formatTimestamp(epoch: number, timezone: string): string {
	const d = new Date(epoch * 1000);
	const parts = new Intl.DateTimeFormat('sv-SE', {
		timeZone: timezone,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false,
	}).formatToParts(d);
	const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
	const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
	const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
	const localMs = new Date(local + 'Z').getTime();
	const offsetMin = (localMs - utc) / 60000;
	const sign = offsetMin >= 0 ? '+' : '-';
	const absMin = Math.abs(offsetMin);
	const oh = String(Math.floor(absMin / 60)).padStart(2, '0');
	const om = String(absMin % 60).padStart(2, '0');
	return `${local}${sign}${oh}:${om}`;
}

// --- Grouping helper ---

function hasToolResult(content: string): boolean {
	try {
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed.some((b: any) => b.type === 'tool_result');
	} catch {}
	return false;
}

export function groupRows(rows: MessageRow[], gapSeconds: number): Group[] {
	if (!rows.length) return [];

	const groups: Group[] = [];
	let current: MessageRow[] = [rows[0]];

	for (let i = 1; i < rows.length; i++) {
		const gap = rows[i].created_at - rows[i - 1].created_at > gapSeconds;
		const isToolResult = hasToolResult(rows[i].content);
		if (gap && !isToolResult) {
			groups.push({ start: current[0].rowid, end: current[current.length - 1].rowid, messages: current });
			current = [];
		}
		current.push(rows[i]);
	}
	groups.push({ start: current[0].rowid, end: current[current.length - 1].rowid, messages: current });

	return groups;
}

// --- Memory class ---

export class Memory {
	private db: Database.Database;
	private timezone: string;

	constructor(db: Database.Database, timezone: string) {
		this.timezone = timezone;
		this.db = db;

		// Migrate from old schema: drop context_content/archived_at, add archived
		const cols = db.pragma('table_info(messages)') as Array<{ name: string }>;
		const colNames = new Set(cols.map(c => c.name));
		if (colNames.has('context_content')) {
			db.exec(`
				CREATE TABLE messages_new (
					chat_message_id TEXT PRIMARY KEY,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					created_at INTEGER DEFAULT (unixepoch()),
					archived INTEGER NOT NULL DEFAULT 0
				);
				INSERT INTO messages_new (chat_message_id, role, content, created_at)
					SELECT chat_message_id, role, content, created_at FROM messages;
				DROP TABLE messages;
				ALTER TABLE messages_new RENAME TO messages;
			`);
		}

		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				chat_message_id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER DEFAULT (unixepoch()),
				archived INTEGER NOT NULL DEFAULT 0
			);
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS compacted (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				summary TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				archived INTEGER NOT NULL DEFAULT 0
			);
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS compaction_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				op TEXT NOT NULL,
				group_start INTEGER,
				group_end INTEGER,
				tokens_before INTEGER,
				tokens_after INTEGER,
				reason TEXT NOT NULL DEFAULT '',
				created_at TEXT DEFAULT (datetime('now'))
			);
		`);
		// Migration: add tokens column to messages (lazy — computed on demand)
		const msgCols = db.pragma('table_info(messages)') as Array<{ name: string }>;
		if (!msgCols.some(c => c.name === 'tokens')) {
			db.exec("ALTER TABLE messages ADD COLUMN tokens INTEGER");
		}

		// Migration: add reason column
		const logCols = db.pragma('table_info(compaction_log)') as Array<{ name: string }>;
		if (!logCols.some(c => c.name === 'reason')) {
			db.exec("ALTER TABLE compaction_log ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
		}
	}

	add(role: 'user' | 'assistant', content: string | ContentBlock[], chatMessageId?: string): void {
		if (typeof content === 'string' && !content.length) return;
		if (Array.isArray(content) && !content.length) return;
		const serialized = typeof content === 'string' ? content : JSON.stringify(content);
		const id = chatMessageId ?? crypto.randomUUID();
		this.db.prepare('INSERT INTO messages (chat_message_id, role, content) VALUES (?, ?, ?)').run(id, role, serialized);
	}

	/** Delete a message only if it hasn't been compacted yet. */
	deleteUncompacted(chatMessageId: string): boolean {
		return this.db.prepare(
			'DELETE FROM messages WHERE chat_message_id = ? AND NOT archived'
		).run(chatMessageId).changes > 0;
	}

	/** Delete a message and all messages after it (by rowid). Returns count deleted. */
	forget(chatMessageId: string): number {
		return this.db.prepare(
			'DELETE FROM messages WHERE rowid >= (SELECT rowid FROM messages WHERE chat_message_id = ?)'
		).run(chatMessageId).changes;
	}

	// --- Compaction DB operations ---

	/** Get token count for a message, computing and persisting if needed. */
	messageTokens(m: MessageRow): number {
		if (m.tokens != null) return m.tokens;
		m.tokens = estimateTokens(m.content);
		this.db.prepare('UPDATE messages SET tokens = ? WHERE rowid = ?').run(m.tokens, m.rowid);
		return m.tokens;
	}

	/** Total tokens in unarchived messages. */
	tokenUsage(): number {
		const uncached = this.db.prepare(
			'SELECT rowid, content FROM messages WHERE NOT archived AND tokens IS NULL'
		).all() as Array<{ rowid: number; content: string }>;
		if (uncached.length) {
			const update = this.db.prepare('UPDATE messages SET tokens = ? WHERE rowid = ?');
			this.db.transaction(() => { for (const r of uncached) update.run(estimateTokens(r.content), r.rowid); })();
		}
		return (this.db.prepare(
			'SELECT coalesce(sum(tokens), 0) as total FROM messages WHERE NOT archived'
		).get() as { total: number }).total;
	}

	// TODO: fromRowid/toRowid are interpolated into SQL — parameterize when adding user-facing callers
	/** Identify groups of messages by time gaps. */
	identifyGroups(gapSeconds: number, opts?: { includeArchived?: boolean; fromRowid?: number; toRowid?: number }): Group[] {
		const { includeArchived = false, fromRowid, toRowid } = opts ?? {};
		const conditions = includeArchived ? [] : ['NOT archived'];
		if (fromRowid != null) conditions.push(`rowid >= ${fromRowid}`);
		if (toRowid != null) conditions.push(`rowid <= ${toRowid}`);
		const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
		const rows = this.db.prepare(
			`SELECT rowid, chat_message_id, role, content, created_at, archived, tokens FROM messages ${where} ORDER BY rowid`
		).all() as MessageRow[];
		return groupRows(rows, gapSeconds);
	}

	/** Get uncompressed groups (eligible for compression). */
	getUncompressedGroups(gapSeconds: number): Group[] {
		return this.identifyGroups(gapSeconds);
	}

	/** Get all non-archived compacted summaries. */
	getCompactedSummaries(): Array<{ summary: string; created_at: number }> {
		return this.db.prepare(
			'SELECT summary, created_at FROM compacted WHERE NOT archived ORDER BY id'
		).all() as Array<{ summary: string; created_at: number }>;
	}

	/** Get non-archived compacted rows with IDs (for distillation). */
	getUnarchivedCompacted(): Array<{ id: number; summary: string }> {
		return this.db.prepare(
			'SELECT id, summary FROM compacted WHERE NOT archived ORDER BY id'
		).all() as Array<{ id: number; summary: string }>;
	}

	/** Write compaction results: INSERT summary into compacted table, archive source messages. */
	writeCompacted(messages: MessageRow[], summary: string): void {
		const lastTs = messages[messages.length - 1].created_at;
		const tx = this.db.transaction(() => {
			this.db.prepare(
				'INSERT INTO compacted (role, summary, created_at) VALUES (?, ?, ?)'
			).run('assistant', summary, lastTs);
			this.db.prepare(
				'UPDATE messages SET archived = 1 WHERE rowid BETWEEN ? AND ?'
			).run(messages[0].rowid, messages[messages.length - 1].rowid);
		});
		tx();
		log.debug('wrote compacted', { chars: String(summary.length), archived: String(messages.length) });
	}

	/** Archive compacted rows up to cutoffId. Returns count archived. */
	archiveCompacted(cutoffId: number): number {
		return this.db.prepare(
			'UPDATE compacted SET archived = 1 WHERE NOT archived AND id <= ?'
		).run(cutoffId).changes;
	}

	/** Log a compaction operation. */
	logCompaction(op: string, groupStart: number, groupEnd: number, tokensBefore: number, tokensAfter: number, reason: string, tokenBudget: number): void {
		const pct = Math.round(tokensBefore / tokenBudget * 100);
		const k = (n: number) => n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
		const full = `${reason}, rows ${groupStart}-${groupEnd}, ${k(tokensBefore)} -> ${k(tokensAfter)} tokens (${pct}% of ${k(tokenBudget)})`;
		this.db.prepare(
			'INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after, reason) VALUES (?, ?, ?, ?, ?, ?)'
		).run(op, groupStart, groupEnd, tokensBefore, tokensAfter, full);
	}

	/** Build prior context for compaction LLM (memory.md + compacted history). */
	buildPriorContext(promptsDir: string): string | undefined {
		const parts: string[] = [];
		let mem = '';
		try { mem = readFileSync(`${promptsDir}/memory.md`, 'utf-8').trim(); } catch {}
		if (mem) parts.push(`## Memory\n${mem}`);
		const rows = this.getCompactedSummaries();
		if (rows.length) parts.push(`## Compacted history\n${rows.map(s => s.summary).join('\n\n')}`);
		return parts.length ? parts.join('\n\n') : undefined;
	}

	// --- Context building ---

	/** Compacted history formatted as text for the system prompt. */
	getCompactedHistory(): string {
		const compacted = this.getCompactedSummaries();
		if (!compacted.length) return '';
		return compacted.map(c => c.summary).join('\n\n');
	}

	getContext(): Message[] {
		const rows = this.db.prepare(
			'SELECT role, content, created_at FROM messages WHERE NOT archived ORDER BY rowid'
		).all() as Array<{ role: string; content: string; created_at: number }>;

		const messages: Message[] = [];
		const fmt = (epoch: number) => formatTimestamp(epoch, this.timezone);

		function pushMessage(role: 'user' | 'assistant', content: string | ContentBlock[]) {
			const prev = messages[messages.length - 1];
			if (prev && prev.role === role && typeof prev.content === 'string' && typeof content === 'string') {
				prev.content += '\n\n' + content;
			} else {
				messages.push({ role, content });
			}
		}

		for (const r of rows) {
			const ts = fmt(r.created_at);
			let content: string | ContentBlock[];
			try {
				const parsed = JSON.parse(r.content);
				if (Array.isArray(parsed)) {
					// Only prepend timestamp to user messages (not tool_results, not assistant)
					const addTs = r.role === 'user' && !parsed.some((b: any) => b.type === 'tool_result');
					content = addTs ? [{ type: 'text', text: `[${ts}]` } as ContentBlock, ...parsed] : parsed;
				} else {
					content = `[${ts}] ${r.content}`;
				}
			} catch {
				content = `[${ts}] ${r.content}`;
			}
			pushMessage(r.role as 'user' | 'assistant', content);
		}

		// Drop leading messages with orphaned tool_results (no matching tool_use before them)
		while (messages.length > 0) {
			const msg = messages[0];
			if (!Array.isArray(msg.content)) break;
			const toolResults = msg.content.filter(b => b.type === 'tool_result') as
				Array<Extract<ContentBlock, { type: 'tool_result' }>>;
			if (!toolResults.length) break;
			messages.shift();
		}

		// Inject virtual tool_results for orphaned tool_use blocks (e.g. process killed mid-execution)
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
			const toolUses = msg.content.filter(b => b.type === 'tool_use') as
				Array<Extract<ContentBlock, { type: 'tool_use' }>>;
			if (!toolUses.length) continue;

			// Collect tool_result IDs from the next user message
			const next = messages[i + 1];
			const answeredIds = new Set<string>();
			if (next && next.role === 'user' && Array.isArray(next.content)) {
				for (const b of next.content) {
					if (b.type === 'tool_result') answeredIds.add((b as Extract<ContentBlock, { type: 'tool_result' }>).tool_use_id);
				}
			}

			const missing = toolUses.filter(tu => !answeredIds.has(tu.id));
			if (!missing.length) continue;

			const synthetic: ContentBlock[] = missing.map(tu => ({
				type: 'tool_result' as const,
				tool_use_id: tu.id,
				content: '(aborted)',
			}));

			if (next && next.role === 'user' && Array.isArray(next.content)) {
				next.content = [...next.content, ...synthetic];
			} else {
				// No user message follows — insert one
				messages.splice(i + 1, 0, { role: 'user', content: synthetic });
			}
		}

		return messages;
	}

	// --- Stats ---

	getMemoryStats(memoryPath: string, tokenBudget: number, systemText: string, memoryText: string) {
		const flow = this.db.prepare(
			'SELECT count(*) as count, coalesce(sum(tokens), 0) as tokens FROM messages WHERE NOT archived'
		).get() as { count: number; tokens: number };
		const flowTokens = flow.tokens;

		const compacted = this.db.prepare(
			'SELECT count(*) as count FROM compacted WHERE NOT archived'
		).get() as { count: number };
		const compactedContent = this.db.prepare(
			'SELECT summary FROM compacted WHERE NOT archived'
		).all() as Array<{ summary: string }>;
		const compactedTokens = compactedContent.reduce((sum, r) => sum + estimateTokens(r.summary), 0);

		const compactedGroups = this.db.prepare(
			"SELECT count(DISTINCT group_end) as count FROM compaction_log WHERE op = 'compress'"
		).get() as { count: number };

		const archived = this.db.prepare(
			'SELECT count(*) as count FROM messages WHERE archived'
		).get() as { count: number };

		const compressions = this.db.prepare(
			"SELECT created_at, reason FROM compaction_log WHERE op = 'compress' ORDER BY id DESC LIMIT 10"
		).all() as Array<{ created_at: string; reason: string }>;

		const distillations = this.db.prepare(
			"SELECT created_at, reason FROM compaction_log WHERE op = 'distill' ORDER BY id DESC LIMIT 10"
		).all() as Array<{ created_at: string; reason: string }>;

		const systemTokens = estimateTokens(systemText);
		const memoryTokens = estimateTokens(memoryText);
		const used = systemTokens + memoryTokens + compactedTokens + flowTokens;

		return {
			context: {
				system:    { tokens: systemTokens,    pct: Math.round(systemTokens / tokenBudget * 100) },
				memory:    { tokens: memoryTokens,    pct: Math.round(memoryTokens / tokenBudget * 100) },
				compacted: { tokens: compactedTokens, pct: Math.round(compactedTokens / tokenBudget * 100), groups: compactedGroups.count },
				flow:      { tokens: flowTokens,      pct: Math.round(flowTokens / tokenBudget * 100), messages: flow.count },
				total:     { tokens: used,             pct: Math.round(used / tokenBudget * 100) },
				budget:    tokenBudget,
			},
			archived: { messages: archived.count },
			ops: {
				compressions: compressions.map(r => ({ at: r.created_at, reason: r.reason })),
				distillations: distillations.map(r => ({ at: r.created_at, reason: r.reason })),
			},
		};
	}
}
