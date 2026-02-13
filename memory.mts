import Database from 'better-sqlite3';
import { ContentBlock, Message } from './llm.mts';
import { Logger } from './log.mts';
import { getCompactedSummaries, formatTimestamp } from './compaction.mts';

const log = new Logger({ module: 'Memory' });

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
				created_at TEXT DEFAULT (datetime('now'))
			);
		`);
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

	/** Compacted history formatted as text for the system prompt. */
	getCompactedHistory(): string {
		const compacted = getCompactedSummaries(this.db);
		if (!compacted.length) return '';
		const fmt = (epoch: number) => formatTimestamp(epoch, this.timezone);
		const roleLabel = (role: string) => role === 'user' ? 'User' : 'Agent';
		return compacted.map(({ role, summary, created_at }) =>
			`[:${fmt(created_at)}] ${roleLabel(role)}: ${summary}`
		).join('\n\n');
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

}
