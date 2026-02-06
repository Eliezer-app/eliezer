import Database from 'better-sqlite3';

export interface AgentEvent {
	id: number;
	source: string;
	type: string;
	payload: unknown;
	created_at: string;
}

export class EventQueue {
	private db: Database.Database;
	private waiter: ((event: AgentEvent) => void) | null = null;

	constructor(db: Database.Database) {
		this.db = db;
		this.migrate(db);
	}

	private migrate(db: Database.Database) {
		// Migrate old 'queue' table if it exists
		const oldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queue'").get();
		if (oldTable) {
			db.exec('DROP TABLE queue');
		}

		db.exec(`
			CREATE TABLE IF NOT EXISTS event_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				type TEXT NOT NULL,
				payload TEXT NOT NULL DEFAULT '{}',
				status TEXT NOT NULL DEFAULT 'pending',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
	}

	push(source: string, type: string, payload: unknown = {}): number {
		const result = this.db.prepare(
			'INSERT INTO event_queue (source, type, payload) VALUES (?, ?, ?)'
		).run(source, type, JSON.stringify(payload));
		const id = result.lastInsertRowid as number;

		if (this.waiter) {
			const row = this.db.prepare('SELECT * FROM event_queue WHERE id = ?').get(id) as any;
			if (row) {
				this.db.prepare("UPDATE event_queue SET status = 'processing' WHERE id = ?").run(id);
				const w = this.waiter;
				this.waiter = null;
				w(this.rowToEvent(row));
			}
		}
		return id;
	}

	pop(): Promise<AgentEvent> {
		const row = this.db.prepare(
			"SELECT * FROM event_queue WHERE status = 'pending' ORDER BY id LIMIT 1"
		).get() as any;
		if (row) {
			this.db.prepare("UPDATE event_queue SET status = 'processing' WHERE id = ?").run(row.id);
			return Promise.resolve(this.rowToEvent(row));
		}
		return new Promise(resolve => { this.waiter = resolve; });
	}

	cancelWait(): void { this.waiter = null; }

	done(id: number): void {
		this.db.prepare("UPDATE event_queue SET status = 'done' WHERE id = ?").run(id);
	}

	depth(): number {
		const row = this.db.prepare(
			"SELECT count(*) as n FROM event_queue WHERE status = 'pending'"
		).get() as any;
		return row?.n ?? 0;
	}

	private rowToEvent(row: any): AgentEvent {
		return { id: row.id, source: row.source, type: row.type, payload: JSON.parse(row.payload), created_at: row.created_at };
	}
}
