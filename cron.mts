import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

export interface CronRow {
	name: string;
	prompt: string;
	cron: string;
	cronHuman: string;
	enabled: boolean;
	last_run: string | null;
	created_at: string;
}

export class CronManager {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		db.exec(`
			CREATE TABLE IF NOT EXISTS crons (
				name TEXT PRIMARY KEY,
				prompt TEXT NOT NULL,
				cron TEXT NOT NULL,
				enabled INTEGER DEFAULT 1,
				last_run TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);
		`);
		// Migrate from old schema (command → prompt)
		const cols = db.pragma('table_info(crons)') as Array<{ name: string }>;
		const colNames = new Set(cols.map(c => c.name));
		if (colNames.has('command') && !colNames.has('prompt')) {
			db.exec('ALTER TABLE crons RENAME COLUMN command TO prompt');
		}
	}

	create(name: string, prompt: string, cron: string): void {
		CronExpressionParser.parse(cron);
		this.db.prepare(
			'INSERT OR REPLACE INTO crons (name, prompt, cron) VALUES (?, ?, ?)'
		).run(name, prompt, cron);
	}

	pause(name: string): boolean {
		return this.db.prepare('UPDATE crons SET enabled = 0 WHERE name = ?').run(name).changes > 0;
	}

	resume(name: string): boolean {
		return this.db.prepare('UPDATE crons SET enabled = 1 WHERE name = ?').run(name).changes > 0;
	}

	delete(name: string): boolean {
		return this.db.prepare('DELETE FROM crons WHERE name = ?').run(name).changes > 0;
	}

	setEnabled(name: string, enabled: boolean): boolean {
		return this.db.prepare('UPDATE crons SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name).changes > 0;
	}

	list(): CronRow[] {
		const rows = this.db.prepare('SELECT * FROM crons ORDER BY created_at').all() as Array<{
			name: string; prompt: string; cron: string; enabled: number; last_run: string | null; created_at: string;
		}>;
		return rows.map(r => ({
			name: r.name,
			prompt: r.prompt,
			cron: r.cron,
			cronHuman: cronstrue.toString(r.cron),
			enabled: r.enabled === 1,
			last_run: r.last_run,
			created_at: r.created_at,
		}));
	}

	checkDue(): Array<{ name: string; prompt: string }> {
		const rows = this.db.prepare(
			'SELECT name, prompt, cron, last_run FROM crons WHERE enabled = 1'
		).all() as Array<{ name: string; prompt: string; cron: string; last_run: string | null }>;

		const due: Array<{ name: string; prompt: string }> = [];
		const now = new Date();

		for (const row of rows) {
			const interval = CronExpressionParser.parse(row.cron, { currentDate: now });
			const prev = interval.prev().toDate();

			if (!row.last_run || new Date(row.last_run + 'Z') < prev) {
				due.push({ name: row.name, prompt: row.prompt });
				this.db.prepare("UPDATE crons SET last_run = datetime('now') WHERE name = ?").run(row.name);
			}
		}

		return due;
	}
}
