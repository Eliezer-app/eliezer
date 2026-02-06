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
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER DEFAULT (unixepoch())
			);
		`);
	}

	add(role: 'user' | 'assistant', content: string | ContentBlock[]): void {
		if (typeof content === 'string' && !content.length) return;
		if (Array.isArray(content) && !content.length) return;
		const serialized = typeof content === 'string' ? content : JSON.stringify(content);
		this.db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').run(role, serialized);
	}

	getContext(): Message[] {
		const rows = this.db.prepare(
			'SELECT role, content FROM messages ORDER BY id DESC LIMIT ?'
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
