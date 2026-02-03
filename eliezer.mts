import { execSync } from 'child_process';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { config } from 'dotenv';

config({ path: '/opt/eliezer/credentials.env' });

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Task {
	id?: number;
	type: string;
	payload?: string;
}

class ThinkTask implements Task {
	type = 'think';
}

type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
	| { type: 'tool_result'; tool_use_id: string; content: string };

interface Message {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

class Memory {
	private db: Database.Database;
	private contextLimit = 100;

	constructor(db: Database.Database) {
		this.db = db;
		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER DEFAULT (unixepoch())
			);
		`);
	}

	add(role: string, content: string | ContentBlock[]): void {
		// Skip empty content
		if (typeof content === 'string' && content.length === 0) return;
		if (Array.isArray(content) && content.length === 0) return;
		const serialized = typeof content === 'string' ? content : JSON.stringify(content);
		this.db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)')
			.run(role, serialized);
		this.maybeCompact();
	}

	getContext(): Message[] {
		const rows = this.db.prepare(`
			SELECT role, content FROM messages
			ORDER BY id DESC LIMIT ?
		`).all(this.contextLimit) as Array<{ role: string; content: string }>;

		return rows.reverse().map(r => {
			let content: string | ContentBlock[];
			try {
				const parsed = JSON.parse(r.content);
				content = Array.isArray(parsed) ? parsed : r.content;
			} catch {
				content = r.content;
			}
			return { role: r.role as 'user' | 'assistant', content };
		}).filter(m => {
			// Filter out empty content
			if (typeof m.content === 'string') return m.content.length > 0;
			if (Array.isArray(m.content)) return m.content.length > 0;
			return true;
		});
	}

	private maybeCompact(): void {
		// TODO: implement LLM-based compaction when context grows too large
	}
}

class Queue {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				payload TEXT DEFAULT '{}',
				created_at INTEGER DEFAULT (unixepoch())
			);
		`);
	}

	push(type: string, payload: object = {}) {
		this.db.prepare('INSERT INTO queue (type, payload) VALUES (?, ?)')
			.run(type, JSON.stringify(payload));
	}

	pop(): Task | null {
		return this.db.prepare('SELECT * FROM queue ORDER BY id LIMIT 1').get() as Task | null;
	}

	done(id: number) {
		this.db.prepare('DELETE FROM queue WHERE id = ?').run(id);
	}
}

const TOOLS = [
	{
		name: 'exec',
		description: 'Run a shell command and return the output',
		input_schema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The shell command to execute' }
			},
			required: ['command']
		}
	},
	{
		name: 'write',
		description: 'Write content to a file',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The file path to write to' },
				content: { type: 'string', description: 'The content to write' }
			},
			required: ['path', 'content']
		}
	},
	{
		name: 'read',
		description: 'Read the contents of a file',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The file path to read' }
			},
			required: ['path']
		}
	},
	{
		name: 'wait',
		description: 'Pause autonomous thinking and wait for external tasks from the queue',
		input_schema: {
			type: 'object',
			properties: {}
		}
	},
	{
		name: 'exit',
		description: 'Terminate the process',
		input_schema: {
			type: 'object',
			properties: {}
		}
	}
];

class LLM {
	private apiKey = process.env.ANTHROPIC_API_KEY!;
	private model = process.env.MODEL || 'claude-sonnet-4-5-20250514';

	async call(messages: Message[], system: string): Promise<{ content: ContentBlock[]; stop_reason: string }> {
		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': this.apiKey,
				'content-type': 'application/json',
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: 4096,
				system,
				tools: TOOLS,
				messages,
			}),
		});

		const data = await response.json();
		if (data.error) {
			throw new Error(data.error.message);
		}
		budget.add(data.usage?.input_tokens || 0, data.usage?.output_tokens || 0);
		return { content: data.content || [], stop_reason: data.stop_reason };
	}
}

class Log {
	constructor(private path: string) {}

	info(msg: string) {
		const line = JSON.stringify({ ts: new Date().toISOString(), msg }) + '\n';
		appendFileSync(this.path, line);
		process.stdout.write(`${msg}\n`);
	}

	tool(name: string, input: Record<string, any>, result: string, isError: boolean) {
		const arg = input.command || input.path || '';
		const short = arg.length > 60 ? arg.slice(0, 57) + '...' : arg;
		const status = isError ? `err` : `ok`;
		const line = JSON.stringify({ ts: new Date().toISOString(), tool: name, input, result, isError }) + '\n';
		appendFileSync(this.path, line);
		process.stdout.write(`  [${name}] ${short} → ${status}\n`);
	}

	text(text: string) {
		const short = text.length > 100 ? text.slice(0, 97) + '...' : text;
		process.stdout.write(`  ${short}\n`);
	}
}

const budget = {
	used: 0,
	limit: 500_000,
	add(input: number, output: number) { this.used += input + output; },
	hasRemaining() { return this.used < this.limit; },
};

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE LOOP
// ═══════════════════════════════════════════════════════════════════════════════

mkdirSync('/opt/eliezer/state', { recursive: true });
mkdirSync('/var/log/eliezer', { recursive: true });
const db = new Database('/opt/eliezer/state/eliezer.db');
const queue = new Queue(db);
const memory = new Memory(db);
const llm = new LLM();
const log = new Log('/var/log/eliezer/eliezer.log');

let running = true;
let waiting = false;

function executeTool(name: string, input: Record<string, any>): { result: string; isError: boolean } {
	try {
		switch (name) {
			case 'exec':
				return { result: execSync(input.command, { encoding: 'utf-8', timeout: 30_000 }), isError: false };
			case 'write':
				writeFileSync(input.path, input.content);
				return { result: 'ok', isError: false };
			case 'read':
				return { result: readFileSync(input.path, 'utf-8'), isError: false };
			case 'wait':
				waiting = true;
				log.info('◦ waiting');
				return { result: 'ok', isError: false };
			case 'exit':
				running = false;
				return { result: 'ok', isError: false };
			default:
				return { result: `Unknown tool: ${name}`, isError: true };
		}
	} catch (e: any) {
		return { result: e.message, isError: true };
	}
}

function getSystem(): string {
	const base = readFileSync('/opt/eliezer/prompt.txt', 'utf-8');
	return `${base}

STATE: ${budget.used}/${budget.limit} tokens used`;
}

async function handle(task: Task) {
	log.info(task.type === 'think' ? '● think' : `● task: ${task.type}`);

	const userMessage = task.type === 'think'
		? 'Continue your work. What should you do next?'
		: `Task: ${task.type}\n${task.payload || ''}`;

	memory.add('user', userMessage);

	// Agentic loop: keep going while model wants to use tools
	while (true) {
		const context = memory.getContext();
		const response = await llm.call(context, getSystem());

		// Log and store assistant response
		for (const block of response.content) {
			if (block.type === 'text') {
				log.text(block.text);
			}
		}
		memory.add('assistant', response.content);

		// Check for tool use
		const toolUses = response.content.filter(b => b.type === 'tool_use') as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, any> }>;

		if (toolUses.length === 0) {
			// No tools called, done with this turn
			break;
		}

		// Execute tools and collect results
		const toolResults: ContentBlock[] = [];
		for (const toolUse of toolUses) {
			const { result, isError } = executeTool(toolUse.name, toolUse.input);
			log.tool(toolUse.name, toolUse.input, result, isError);
			toolResults.push({
				type: 'tool_result',
				tool_use_id: toolUse.id,
				content: result
			});
		}

		// Add tool results as user message and continue loop
		memory.add('user', toolResults);
	}
}

log.info('▶ eliezer starting');

while (running) {
	const task = queue.pop();

	if (task) {
		await handle(task);
		queue.done(task.id!);
	} else if (!waiting && budget.hasRemaining()) {
		await handle(new ThinkTask());
	} else {
		await sleep(1_000);
	}
}

log.info('■ eliezer exiting');
