import { config } from 'dotenv';
config();
import { readFileSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import { CronManager } from '../cron.mts';

const DB_PATH = process.env.DB_PATH as string;
const PROMPTS_DIR = process.env.PROMPTS_DIR as string;
const USER_TZ = process.env.USER_TZ as string;

const db = new Database(DB_PATH);
const memory = new Memory(db, USER_TZ);
const cronManager = new CronManager(db);

function readPrompt(name: string): string {
	try { return readFileSync(`${PROMPTS_DIR}/${name}`, 'utf-8').trim(); }
	catch { return ''; }
}

const parts = [readPrompt('system.md'), readPrompt('user.md'), readPrompt('widgets.md')];
const mem = readPrompt('memory.md');
if (mem) parts.push(`# Memory\n${mem}`);
const crons = cronManager.list();
if (crons.length) {
	const lines = crons.map(c =>
		`- ${c.name}: "${c.prompt}" (${c.cronHuman}${c.enabled ? '' : ', disabled'})`
	);
	parts.push(`# Scheduled Tasks\n${lines.join('\n')}`);
}
const history = memory.getCompactedHistory();
if (history) parts.push(`# Conversation History\n${history}`);

const system = parts.filter(Boolean).join('\n\n');
const out = process.argv[2] || 'state/system-dump.txt';
writeFileSync(out, system + '\n');
console.log(`Wrote ${system.length} chars to ${out}`);
