import { config } from 'dotenv';
import { mkdirSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { Logger } from './log.mts';
import { LLMBase, AnthropicLLM, OpenAILLM, ContentBlock } from './llm.mts';
import { EventQueue, AgentEvent } from './queue.mts';
import { Memory } from './memory.mts';
import { startServer } from './server.mts';
import { createTools } from './tools.mts';
import { ChatClient, createChatTool } from './chat.mts';

config();

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1); }
	return val;
}

const LLM_PROVIDER = requireEnv('LLM_PROVIDER');
const LLM_API_KEY = requireEnv('LLM_API_KEY');
const LLM_BASE_URL = requireEnv('LLM_BASE_URL');
const LLM_MODEL = requireEnv('LLM_MODEL');
const AGENT_PORT = requireEnv('AGENT_PORT');
const DB_PATH = requireEnv('DB_PATH');
const CHAT_URL = requireEnv('CHAT_URL');
const PROMPTS_DIR = requireEnv('PROMPTS_DIR');
const HEARTBEAT_MS = Number(requireEnv('HEARTBEAT_MS').replace(/_/g, ''));

const log = new Logger();

// DB
mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
const db = new Database(DB_PATH);

// Components
const queue = new EventQueue(db);
const memory = new Memory(db);
const llm: LLMBase = LLM_PROVIDER === 'anthropic'
	? new AnthropicLLM({ apiKey: LLM_API_KEY, model: LLM_MODEL, baseUrl: LLM_BASE_URL })
	: new OpenAILLM({ apiKey: LLM_API_KEY, model: LLM_MODEL, baseUrl: LLM_BASE_URL });
const chat = new ChatClient(CHAT_URL);
const tools = [...createTools(), createChatTool(chat)];
const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

function readPrompt(name: string): string {
	try { return readFileSync(`${PROMPTS_DIR}/${name}`, 'utf-8').trim(); }
	catch { return ''; }
}

function getSystem(): string {
	const parts = [readPrompt('system.md'), readPrompt('user.md')];
	const mem = readPrompt('memory.md');
	if (mem) parts.push(`# Memory\n${mem}`);
	return parts.filter(Boolean).join('\n\n');
}

// HTTP server
const startTime = Date.now();
startServer(
	parseInt(AGENT_PORT),
	queue,
	() => ({
		status: 'ok',
		uptime: Math.floor((Date.now() - startTime) / 1000),
		queueDepth: queue.depth(),
		tokensUsed: llm.tokensUsed,
	}),
	log.with({ module: 'Server' }),
);

// Main loop
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

log.info('eliezer starting');

while (true) {
	const popPromise = queue.pop();
	const event = await Promise.race([
		popPromise,
		sleep(HEARTBEAT_MS).then(() => undefined),
	]);

	if (!event) {
		queue.cancelWait();
		continue;
	}

	try {
		await handleEvent(event);
	} catch (e: any) {
		log.error('event failed', { source: event.source, type: event.type, error: e.message });
	}
	queue.done(event.id);
}

async function handleEvent(event: AgentEvent) {
	log.info('handling event', { source: event.source, type: event.type });

	memory.add('user', `Event: ${event.source}:${event.type}\n${JSON.stringify(event.payload)}`);

	while (true) {
		const response = await llm.call(memory.getContext(), getSystem(), toolDefs);

		for (const block of response.content) {
			if (block.type === 'text') log.info('llm', { text: block.text });
		}
		memory.add('assistant', response.content);

		const toolUses = response.content.filter(b => b.type === 'tool_use') as
			Array<Extract<ContentBlock, { type: 'tool_use' }>>;
		if (!toolUses.length) {
			const text = response.content
				.filter(b => b.type === 'text')
				.map(b => (b as Extract<ContentBlock, { type: 'text' }>).text)
				.join('\n');
			if (text) await chat.send('default', text);
			break;
		}

		const results: ContentBlock[] = [];
		let shouldBreak = false;

		for (const tu of toolUses) {
			const tool = tools.find(t => t.name === tu.name);
			if (!tool) {
				results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}` });
				continue;
			}
			const { content, isError, signal } = await tool.call(tu.input);
			log.info(`tool:${tu.name}`, { result: isError ? 'error' : 'ok' });
			results.push({ type: 'tool_result', tool_use_id: tu.id, content });
			if (signal === 'restart') { shouldBreak = true; break; }
		}

		memory.add('user', results);
		if (shouldBreak) break;
	}
}
