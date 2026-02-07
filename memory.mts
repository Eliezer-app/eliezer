import Database from 'better-sqlite3';
import { ContentBlock, Message } from './llm.mts';

export class Memory {
	private db: Database.Database;
	private contextLimit: number;

	constructor(db: Database.Database, contextLimit = 100) {
		this.db = db;
		this.contextLimit = contextLimit;
		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				chat_message_id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER DEFAULT (unixepoch()),
				context_content TEXT,
				archived_at TEXT
			);
		`);
		// Migrate existing tables
		const cols = db.pragma('table_info(messages)') as Array<{ name: string }>;
		const colNames = new Set(cols.map(c => c.name));
		if (!colNames.has('context_content')) db.exec('ALTER TABLE messages ADD COLUMN context_content TEXT');
		if (!colNames.has('archived_at')) db.exec('ALTER TABLE messages ADD COLUMN archived_at TEXT');

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

	deleteByChatMessageId(chatMessageId: string): number {
		return this.db.prepare('DELETE FROM messages WHERE chat_message_id = ?').run(chatMessageId).changes;
	}

	getContext(): Message[] {
		const rows = this.db.prepare(
			'SELECT role, content FROM messages ORDER BY rowid DESC LIMIT ?'
		).all(this.contextLimit) as Array<{ role: string; content: string }>;

		return rows.reverse().map(r => {
			let content: string | ContentBlock[];
			try {
				const parsed = JSON.parse(r.content);
				content = Array.isArray(parsed) ? parsed : r.content;
			} catch {
				content = r.content;
			}
			return { role: r.role as 'user' | 'assistant', content };
		});
	}
}
