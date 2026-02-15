import { config } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { Logger } from './log.mts';
import { createLLM, ContentBlock } from './llm.mts';
import { EventQueue, AgentEvent } from './queue.mts';
import { Memory } from './memory.mts';
import { startServer } from './server.mts';
import { createTools, createScheduleTool, createWebSearchTool } from './tools.mts';
import { createSearchHistoryTool } from './tool-search-history.mts';
import { SearXNGProvider } from './search.mts';
import { CronManager } from './cron.mts';
import { ChatClient, createChatTool } from './chat.mts';
import { Compactor } from './compaction.mts';
import { redactSecrets } from './detect-secret.mts';

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
const SEARCH_URL = requireEnv('SEARCH_URL');
const HEARTBEAT_MS = Number(requireEnv('HEARTBEAT_MS').replace(/_/g, ''));
const USER_TZ = requireEnv('USER_TZ');
const CHAT_PUBLIC_DIR = requireEnv('CHAT_PUBLIC_DIR');

const RESTART_FLAG_FILE = `${DB_PATH}.restart-flag`;
const log = new Logger();

// DB
mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
const db = new Database(DB_PATH);

// Components
const queue = new EventQueue(db);
const memory = new Memory(db, USER_TZ);
const llm = createLLM({ provider: LLM_PROVIDER, apiKey: LLM_API_KEY, model: LLM_MODEL, baseUrl: LLM_BASE_URL });
const compactionLlm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || LLM_PROVIDER,
	apiKey: process.env.COMPACTION_LLM_API_KEY || LLM_API_KEY,
	model: process.env.COMPACTION_LLM_MODEL || LLM_MODEL,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || LLM_BASE_URL,
	timeoutMs: 240_000,
	maxTokens: 25_000,
});
const chat = new ChatClient(CHAT_URL);
const cronManager = new CronManager(db);

const CONTEXT_WINDOW = Number(requireEnv('CONTEXT_WINDOW'));

// Compaction config
function parseDuration(s: string, defaultSec: number): number {
	const m = s.match(/^(\d+)(s|m|h)?$/);
	if (!m) return defaultSec;
	const n = parseInt(m[1]);
	switch (m[2]) {
		case 'h': return n * 3600;
		case 'm': return n * 60;
		default: return n;
	}
}
const compactor = new Compactor(memory, compactionLlm, USER_TZ, {
	tokenBudget: CONTEXT_WINDOW,
	groupGapSeconds: parseDuration(process.env.COMPACTION_GROUP_GAP || '1m', 60),
	flowLimitSeconds: parseDuration(process.env.COMPACTION_FLOW_LIMIT || '1m', 60),
	promptsDir: PROMPTS_DIR,
});
const searchProvider = new SearXNGProvider(SEARCH_URL);
const tools = [...createTools(compactionLlm), createChatTool(chat, CHAT_PUBLIC_DIR, db), createSearchHistoryTool(db), createScheduleTool(cronManager), createWebSearchTool(searchProvider, compactionLlm)];
const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

function readPrompt(name: string): string {
	try { return readFileSync(`${PROMPTS_DIR}/${name}`, 'utf-8').trim(); }
	catch { return ''; }
}

function getSystem(): string {
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
	return parts.filter(Boolean).join('\n\n');
}

const startTime = Date.now();
let currentEvent: { source: string; type: string } | null = null;
let abortController: AbortController | null = null;
const STATE_IDLE = 'idle' as const;
const STATE_INFERENCE = 'inference' as const;
const STATE_TOOL_EXECUTION = 'tool_execution' as const;
const STATE_COMPACTION = 'compaction' as const;
type AgentState = typeof STATE_IDLE | typeof STATE_INFERENCE | typeof STATE_TOOL_EXECUTION | typeof STATE_COMPACTION;
let agentState: AgentState = STATE_IDLE;
let debouncedState: AgentState = STATE_IDLE;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function setAgentState(state: AgentState) {
	if (state === agentState) return;
	agentState = state;
	log.debug('state-change', { state });
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(async () => {
		if (debouncedState === agentState) return;
		debouncedState = agentState;
		try { await chat.stateChange(debouncedState); }
		catch (e: any) { log.error('state-change post failed', { state: debouncedState, error: e.message }); }
	}, 100);
}

startServer({
	port: parseInt(AGENT_PORT),
	queue,
	log: log.with({ module: 'Server' }),
	getHealth: () => ({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) }),
	getState: () => ({
		currentEvent,
		state: debouncedState,
		queueDepth: queue.depth(),
		tokensUsed: llm.tokensUsed,
	}),
	getMemory: () => {
		const system = [readPrompt('system.md'), readPrompt('user.md')].filter(Boolean).join('\n\n');
		const mem = readPrompt('memory.md');
		return memory.getMemoryStats(`${PROMPTS_DIR}/memory.md`, CONTEXT_WINDOW, system, mem);
	},
	listCrons: () => cronManager.list(),
	setCronEnabled: (name, enabled) => cronManager.setEnabled(name, enabled),
	stop: () => {
		if (!abortController) return false;
		abortController.abort();
		return true;
	},
	forget: (messageId) => memory.forget(messageId),
});

const compactionLog = log.with({ module: 'Compaction' });

// Main loop
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const HOUSEKEEPING_TYPES = new Set(['message_updated', 'typing']);
const TOOL_OUTPUT_MAX_CHARS = 20_000;
const TOOL_OUTPUT_PREVIEW_CHARS = 200;

async function heartbeat() {
	log.debug('heartbeat');
	setAgentState(STATE_COMPACTION);
	try {
		const t0 = Date.now();
		const result = await compactor.compact();
		if (result) compactionLog.info('idle compaction', {
			groups: String(result.groups), messages: String(result.messages),
			anchors: String(result.anchors),
			tokensBefore: String(result.tokensBefore), tokensAfter: String(result.tokensAfter),
			ratio: (result.tokensAfter / result.tokensBefore * 100).toFixed(1) + '%',
			duration: ((Date.now() - t0) / 1000).toFixed(1) + 's',
		});
	} catch (e: any) {
		compactionLog.error('idle compaction failed', { error: e.message });
	}
	try {
		const t0 = Date.now();
		const distilled = await compactor.distill();
		if (distilled) compactionLog.info('distillation', {
			distilled: String(distilled.distilled), archived: String(distilled.archived),
			duration: ((Date.now() - t0) / 1000).toFixed(1) + 's',
		});
	} catch (e: any) {
		compactionLog.error('distillation failed', { error: e.message });
	}
	setAgentState(STATE_IDLE);
	const dueCrons = cronManager.checkDue();
	for (const { name, prompt } of dueCrons) {
		log.info('cron due', { name });
		queue.push('cron', 'scheduled', { name, prompt });
	}
}

log.info('eliezer starting');

if (existsSync(RESTART_FLAG_FILE)) {
	unlinkSync(RESTART_FLAG_FILE);
	queue.push('system', 'restart', { message: 'You just restarted' });
}

while (true) {
	const popPromise = queue.pop();
	const event = await Promise.race([
		popPromise,
		sleep(HEARTBEAT_MS).then(() => undefined),
	]);

	if (!event) {
		queue.cancelWait();
		currentEvent = null;
		await heartbeat();
		continue;
	}

	if (event.type === 'message_deleted') {
		const payload = event.payload as any;
		const deleted = memory.deleteUncompacted(payload.messageId);
		log.info('message delete requested', { messageId: payload.messageId, deleted });
		queue.done(event.id);
		continue;
	}

	if (HOUSEKEEPING_TYPES.has(event.type)) {
		log.info('skipping housekeeping event', { source: event.source, type: event.type });
		queue.done(event.id);
		continue;
	}

	currentEvent = { source: event.source, type: event.type };
	abortController = new AbortController();
	try {
		const result = await handleEvent(event, abortController.signal);
		if (result === 'restart') {
			queue.done(event.id);
			writeFileSync(RESTART_FLAG_FILE, '');
			log.info('restart requested — exiting');
			process.exit(0);
		}
	} catch (e: any) {
		if (e.name === 'AbortError') {
			log.info('event aborted by user', { source: event.source, type: event.type });
			memory.add('user', '[user stopped agent execution]');
			await chat.send('default', '(stopped)').catch(() => {});
		} else {
			log.error('event failed', { source: event.source, type: event.type, error: e.message });
			try { await chat.send('default', `Error: ${e.message}`); } catch (ce: any) {
				log.error('chat send failed', { error: ce.message });
			}
		}
	}
	abortController = null;
	setAgentState(STATE_IDLE);
	queue.done(event.id);
}

async function handleEvent(event: AgentEvent, signal: AbortSignal) {
	log.info('handling event', { source: event.source, type: event.type });

	const payload = event.payload as any;
	const chatMessageId = payload?.messageId;

	if (event.source === 'cron') {
		memory.add('user', `[cron:${payload.name}] ${payload.prompt}`);
	} else {
		memory.add('user', `Event: ${event.source}:${event.type}\n${JSON.stringify(event.payload)}`, chatMessageId);
	}


	try {
		while (true) {
			if (signal.aborted) {
				log.info('event processing stopped by user');
				memory.add('user', '[user stopped agent execution]');
				await chat.send('default', '(stopped)').catch(() => {});
				break;
			}
			const cp = compactor.prepare();
			if (cp) {
				setAgentState(STATE_COMPACTION);
				const result = await compactor.compactTail(cp);
				if (result) {
					compactionLog.info('emergency compaction', {
						groups: String(result.groups), messages: String(result.messages),
						anchors: String(result.anchors),
						tokensBefore: String(result.tokensBefore), tokensAfter: String(result.tokensAfter),
						ratio: (result.tokensAfter / result.tokensBefore * 100).toFixed(1) + '%',
					});
				}
			}
			setAgentState(STATE_INFERENCE);
			const response = await llm.call(memory.getContext(), getSystem(), toolDefs, signal);

			// Keep text, tool_use, and reasoning blocks. Reasoning is needed for providers
			// that require it on history replay (e.g. Kimi).
			const content = response.content.filter(b => b.type === 'text' || b.type === 'tool_use' || b.type === 'reasoning');
			for (const block of content) {
				if (block.type === 'text') log.info('llm', { text: block.text });
				if (block.type === 'reasoning') {
					const text = (block as any).text || (block as any).content;
					if (text) await chat.send('default', text, 'thought').catch((e: any) => log.error('chat send thought', { error: e.message }));
				}
			}
			const toolUses = response.content.filter(b => b.type === 'tool_use') as
				Array<Extract<ContentBlock, { type: 'tool_use' }>>;
			if (!toolUses.length) {
				const text = response.content
					.filter(b => b.type === 'text')
					.map(b => (b as Extract<ContentBlock, { type: 'text' }>).text)
					.join('\n');
				let sentMessageId: string | undefined;
				if (text && text.trim() !== '[no response]') {
					const res = await chat.send('default', text);
					sentMessageId = res?.messageId;
				}
				memory.add('assistant', content, sentMessageId);
				break;
			}

			memory.add('assistant', content);

			const results: ContentBlock[] = [];
			let shouldBreak: false | 'abort' | 'restart' = false;

			setAgentState(STATE_TOOL_EXECUTION);
			for (const tu of toolUses) {
				if (signal.aborted) { shouldBreak = 'abort'; break; }
				const tool = tools.find(t => t.name === tu.name);
				if (!tool) {
					results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}` });
					continue;
				}
				log.info(`tool:${tu.name}`, { input: JSON.stringify(tu.input) });
				await chat.send('default', JSON.stringify({ tool: tu.name, input: tu.input }), 'tool_call').catch((e: any) => log.error('chat send tool_call', { tool: tu.name, error: e.message }));
				let { content, isError, signal: toolSignal, skipSecretRedaction } = await tool.call(tu.input, signal);
				if (content.length > TOOL_OUTPUT_MAX_CHARS) {
					const preview = content.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
					const size = content.length >= 1000 ? Math.round(content.length / 1000) + 'k' : String(content.length);
					content = `Error: content too large: ${size} chars (limit: ${TOOL_OUTPUT_MAX_CHARS / 1000}k). Use more targeted commands.\n\nFirst ${TOOL_OUTPUT_PREVIEW_CHARS} chars:\n${preview}`;
					isError = true;
				}
				content = redactSecrets(content, skipSecretRedaction);
				log.info(`tool:${tu.name}`, { result: isError ? 'error' : 'ok' });
				await chat.send('default', JSON.stringify({ tool: tu.name, result: content, isError }), 'tool_result').catch((e: any) => log.error('chat send tool_result', { tool: tu.name, error: e.message }));
				results.push({ type: 'tool_result', tool_use_id: tu.id, content });
				if (toolSignal === 'restart') { shouldBreak = 'restart'; break; }
			}

			memory.add('user', results);
			if (shouldBreak) {
				if (shouldBreak === 'abort') {
					memory.add('user', '[user stopped agent execution]');
					await chat.send('default', '(stopped)').catch(() => {});
				}
				if (shouldBreak === 'restart') return 'restart';
				break;
			}
		}
	} catch (e) {
		throw e;
	}
}
