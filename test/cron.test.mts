import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CronManager } from '../cron.mts';

function createDb(): Database.Database {
	return new Database(':memory:');
}

describe('CronManager', () => {
	let db: Database.Database;
	let cron: CronManager;

	beforeEach(() => {
		db = createDb();
		cron = new CronManager(db);
	});

	describe('create', () => {
		it('inserts a cron into the database', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			const rows = cron.list();
			expect(rows).toHaveLength(1);
			expect(rows[0].name).toBe('test');
			expect(rows[0].prompt).toBe('echo hi');
			expect(rows[0].cron).toBe('*/5 * * * *');
			expect(rows[0].enabled).toBe(true);
		});

		it('replaces existing cron with same name', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			cron.create('test', 'echo bye', '*/10 * * * *');
			const rows = cron.list();
			expect(rows).toHaveLength(1);
			expect(rows[0].prompt).toBe('echo bye');
			expect(rows[0].cron).toBe('*/10 * * * *');
		});

		it('rejects invalid cron expression', () => {
			expect(() => cron.create('bad', 'echo', 'not-a-cron')).toThrow();
		});
	});

	describe('pause/resume', () => {
		it('pauses a cron', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			expect(cron.pause('test')).toBe(true);
			expect(cron.list()[0].enabled).toBe(false);
		});

		it('resumes a paused cron', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			cron.pause('test');
			expect(cron.resume('test')).toBe(true);
			expect(cron.list()[0].enabled).toBe(true);
		});

		it('returns false for nonexistent cron', () => {
			expect(cron.pause('nope')).toBe(false);
			expect(cron.resume('nope')).toBe(false);
		});
	});

	describe('delete', () => {
		it('removes a cron', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			expect(cron.delete('test')).toBe(true);
			expect(cron.list()).toHaveLength(0);
		});

		it('returns false for nonexistent cron', () => {
			expect(cron.delete('nope')).toBe(false);
		});
	});

	describe('setEnabled', () => {
		it('toggles enabled state', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			cron.setEnabled('test', false);
			expect(cron.list()[0].enabled).toBe(false);
			cron.setEnabled('test', true);
			expect(cron.list()[0].enabled).toBe(true);
		});

		it('returns false for nonexistent cron', () => {
			expect(cron.setEnabled('nope', false)).toBe(false);
		});
	});

	describe('list', () => {
		it('returns cronHuman field', () => {
			cron.create('test', 'echo hi', '*/5 * * * *');
			const rows = cron.list();
			expect(rows[0].cronHuman).toContain('5');
		});

		it('returns empty array when no crons', () => {
			expect(cron.list()).toEqual([]);
		});
	});

	describe('checkDue', () => {
		it('newly created cron is not immediately due', () => {
			cron.create('test', 'echo hi', '* * * * *'); // every minute
			const due = cron.checkDue();
			expect(due).toHaveLength(0);
		});

		it('cron created in the past is due', () => {
			cron.create('test', 'echo hi', '* * * * *');
			// Backdate created_at so a cron tick has passed since creation
			db.prepare("UPDATE crons SET created_at = datetime('now', '-2 minutes') WHERE name = 'test'").run();
			const due = cron.checkDue();
			expect(due).toHaveLength(1);
			expect(due[0]).toEqual({ name: 'test', prompt: 'echo hi' });
		});

		it('disabled crons are skipped', () => {
			cron.create('test', 'echo hi', '* * * * *');
			cron.pause('test');
			const due = cron.checkDue();
			expect(due).toHaveLength(0);
		});

		it('updates last_run after firing', () => {
			cron.create('test', 'echo hi', '* * * * *');
			db.prepare("UPDATE crons SET created_at = datetime('now', '-2 minutes') WHERE name = 'test'").run();
			cron.checkDue();
			const rows = cron.list();
			expect(rows[0].last_run).not.toBeNull();
		});
	});
});
