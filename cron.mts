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
	run_at: string | null;
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
				cron TEXT NOT NULL DEFAULT '',
				enabled INTEGER DEFAULT 1,
				last_run TEXT,
				run_at TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);
		`);
		const cols = db.pragma('table_info(crons)') as Array<{ name: string }>;
		const colNames = new Set(cols.map(c => c.name));
		if (colNames.has('command') && !colNames.has('prompt')) {
			db.exec('ALTER TABLE crons RENAME COLUMN command TO prompt');
		}
		if (!colNames.has('run_at')) {
			db.exec('ALTER TABLE crons ADD COLUMN run_at TEXT');
		}
	}

	create(name: string, prompt: string, cron: string): void {
		CronExpressionParser.parse(cron);
		this.db.prepare(
			'INSERT OR REPLACE INTO crons (name, prompt, cron, run_at) VALUES (?, ?, ?, NULL)'
		).run(name, prompt, cron);
	}

	createOneShot(name: string, prompt: string, delaySec: number): void {
		const runAt = new Date(Date.now() + delaySec * 1000).toISOString().replace('T', ' ').slice(0, 19);
		this.db.prepare(
			"INSERT OR REPLACE INTO crons (name, prompt, cron, run_at) VALUES (?, ?, '', ?)"
		).run(name, prompt, runAt);
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
			name: string; prompt: string; cron: string; enabled: number; last_run: string | null; run_at: string | null; created_at: string;
		}>;
		return rows.map(r => ({
			name: r.name,
			prompt: r.prompt,
			cron: r.cron,
			cronHuman: r.run_at ? `once at ${r.run_at}Z` : cronstrue.toString(r.cron),
			enabled: r.enabled === 1,
			last_run: r.last_run,
			run_at: r.run_at,
			created_at: r.created_at,
		}));
	}

	checkDue(): Array<{ name: string; prompt: string }> {
		const rows = this.db.prepare(
			'SELECT name, prompt, cron, last_run, run_at, created_at FROM crons WHERE enabled = 1'
		).all() as Array<{ name: string; prompt: string; cron: string; last_run: string | null; run_at: string | null; created_at: string }>;

		const due: Array<{ name: string; prompt: string }> = [];
		const now = new Date();

		for (const row of rows) {
			if (row.run_at) {
				// One-shot: fire when run_at has passed
				if (new Date(row.run_at + 'Z') <= now) {
					due.push({ name: row.name, prompt: row.prompt });
					this.db.prepare('DELETE FROM crons WHERE name = ?').run(row.name);
				}
				continue;
			}

			const interval = CronExpressionParser.parse(row.cron, { currentDate: now, tz: process.env.USER_TZ });
			const prev = interval.prev().toDate();
			const baseline = new Date((row.last_run ?? row.created_at) + 'Z');

			if (baseline < prev) {
				due.push({ name: row.name, prompt: row.prompt });
				this.db.prepare("UPDATE crons SET last_run = datetime('now') WHERE name = ?").run(row.name);
			}
		}

		return due;
	}
}
