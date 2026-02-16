import { config } from 'dotenv';
config();
import { writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';
import { CronManager } from '../cron.mts';
import { TaskManager } from '../tasks.mts';
import { buildSystemPrompt } from '../system-prompt.mts';

const DB_PATH = process.env.DB_PATH as string;
const PROMPTS_DIR = process.env.PROMPTS_DIR as string;
const USER_TZ = process.env.USER_TZ as string;

const db = new Database(DB_PATH);
const memory = new Memory(db, USER_TZ);
const cronManager = new CronManager(db);
const taskManager = new TaskManager(db);

const system = buildSystemPrompt({ promptsDir: PROMPTS_DIR, cronManager, taskManager, memory });
const out = process.argv[2] || 'state/system-dump.txt';
writeFileSync(out, system + '\n');
console.log(`Wrote ${system.length} chars to ${out}`);
