import { config } from 'dotenv';
import { mkdirSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { Logger } from './log.mts';
import { LLMBase, createLLM, ContentBlock } from './llm.mts';
import { EventQueue, AgentEvent } from './queue.mts';
import { Memory } from './memory.mts';
import { startServer } from './server.mts';
import { createTools, createSearchHistoryTool } from './tools.mts';
import { ChatClient, createChatTool } from './chat.mts';
import { getMemoryStats, getUncompressedGroups, compressGroup, estimateTokens, getCompactedSummaries, distillToMemory, archiveGroups } from './compaction.mts';

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
const llm = createLLM({ provider: LLM_PROVIDER, apiKey: LLM_API_KEY, model: LLM_MODEL, baseUrl: LLM_BASE_URL });
const compactionLlm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || LLM_PROVIDER,
	apiKey: process.env.COMPACTION_LLM_API_KEY || LLM_API_KEY,
	model: process.env.COMPACTION_LLM_MODEL || LLM_MODEL,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || LLM_BASE_URL,
});
const chat = new ChatClient(CHAT_URL);
const tools = [...createTools(), createChatTool(chat), createSearchHistoryTool(db)];
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

const startTime = Date.now();
const TOKEN_BUDGET = 80_000;
let currentEvent: { source: string; type: string } | null = null;

startServer({
	port: parseInt(AGENT_PORT),
	queue,
	log: log.with({ module: 'Server' }),
	getHealth: () => ({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) }),
	getState: () => ({
		currentEvent,
		queueDepth: queue.depth(),
		tokensUsed: llm.tokensUsed,
	}),
	getMemory: () => {
		const system = [readPrompt('system.md'), readPrompt('user.md')].filter(Boolean).join('\n\n');
		const mem = readPrompt('memory.md');
		return getMemoryStats(db, `${PROMPTS_DIR}/memory.md`, TOKEN_BUDGET, system.length, mem.length);
	},
});

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
const COMPACTION_GROUP_GAP = parseDuration(process.env.COMPACTION_GROUP_GAP || '1m', 60);
const COMPACTION_FLOW_LIMIT = parseDuration(process.env.COMPACTION_FLOW_LIMIT || '1m', 60);
const IDLE_TARGET = TOKEN_BUDGET / 3;
const EMERGENCY_THRESHOLD = TOKEN_BUDGET * 0.9;
const compactionLog = log.with({ module: 'Compaction' });

function currentTokenUsage(): number {
	const rows = db.prepare(
		"SELECT content FROM messages WHERE context_content IS NULL AND archived_at IS NULL"
	).all() as Array<{ content: string }>;
	return rows.reduce((sum, r) => sum + estimateTokens(r.content), 0);
}

async function idleCompaction(): Promise<void> {
	const tokens = currentTokenUsage();
	if (tokens <= IDLE_TARGET) return;

	const groups = getUncompressedGroups(db, COMPACTION_GROUP_GAP);
	if (groups.length < 2) return; // keep at least the current group

	const now = Math.floor(Date.now() / 1000);
	const oldest = groups[0];
	const lastMsgTime = oldest.messages[oldest.messages.length - 1].created_at;
	if (now - lastMsgTime < COMPACTION_FLOW_LIMIT) return;

	compactionLog.info('idle compression', {
		tokens: String(tokens),
		target: String(IDLE_TARGET),
		groupMessages: String(oldest.messages.length),
	});
	const result = await compressGroup(db, oldest, compactionLlm);
	compactionLog.info('compressed', {
		tokensBefore: String(result.tokensBefore),
		tokensAfter: String(result.tokensAfter),
	});
}

async function emergencyCompaction(): Promise<void> {
	const tokens = currentTokenUsage();
	if (tokens <= EMERGENCY_THRESHOLD) return;

	const groups = getUncompressedGroups(db, COMPACTION_GROUP_GAP);
	if (groups.length < 2) return;

	compactionLog.info('emergency compression', {
		tokens: String(tokens),
		threshold: String(EMERGENCY_THRESHOLD),
	});
	const result = await compressGroup(db, groups[0], compactionLlm);
	compactionLog.info('compressed', {
		tokensBefore: String(result.tokensBefore),
		tokensAfter: String(result.tokensAfter),
	});
}

// Main loop
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const HOUSEKEEPING_TYPES = new Set(['message_updated', 'typing']);
const TOOL_OUTPUT_MAX_CHARS = 20_000;
const TOOL_OUTPUT_PREVIEW_CHARS = 200;

log.info('eliezer starting');

while (true) {
	const popPromise = queue.pop();
	const event = await Promise.race([
		popPromise,
		sleep(HEARTBEAT_MS).then(() => undefined),
	]);

	if (!event) {
		queue.cancelWait();
		currentEvent = null;
		try { await idleCompaction(); } catch (e: any) {
			compactionLog.error('idle compaction failed', { error: e.message });
		}
		continue;
	}

	if (event.type === 'message_deleted') {
		const payload = event.payload as any;
		const deleted = memory.deleteByChatMessageId(payload.messageId);
		log.info('message deleted from memory', { messageId: payload.messageId, deleted });
		queue.done(event.id);
		continue;
	}

	if (HOUSEKEEPING_TYPES.has(event.type)) {
		log.info('skipping housekeeping event', { source: event.source, type: event.type });
		queue.done(event.id);
		continue;
	}

	currentEvent = { source: event.source, type: event.type };
	try {
		await handleEvent(event);
	} catch (e: any) {
		log.error('event failed', { source: event.source, type: event.type, error: e.message });
		try { await chat.send('default', `Error: ${e.message}`); } catch (ce: any) {
			log.error('chat send failed', { error: ce.message });
		}
	}
	queue.done(event.id);
}

async function handleEvent(event: AgentEvent) {
	log.info('handling event', { source: event.source, type: event.type });

	const payload = event.payload as any;
	const chatMessageId = payload?.messageId;
	memory.add('user', `Event: ${event.source}:${event.type}\n${JSON.stringify(event.payload)}`, chatMessageId);

	// Show typing indicator while processing
	await chat.typing(true);

	try {
		while (true) {
			try { await emergencyCompaction(); } catch (e: any) {
				compactionLog.error('emergency compaction failed', { error: e.message });
			}
			const response = await llm.call(memory.getContext(), getSystem(), toolDefs);

			// Keep text, tool_use, and reasoning blocks. Reasoning is needed for providers
			// that require it on history replay (e.g. Kimi). Not sent to chat.
			const content = response.content.filter(b => b.type === 'text' || b.type === 'tool_use' || b.type === 'reasoning');
			for (const block of content) {
				if (block.type === 'text') log.info('llm', { text: block.text });
			}
			const toolUses = response.content.filter(b => b.type === 'tool_use') as
				Array<Extract<ContentBlock, { type: 'tool_use' }>>;
			if (!toolUses.length) {
				// Turn off typing before sending final response
				await chat.typing(false);
				
				const text = response.content
					.filter(b => b.type === 'text')
					.map(b => (b as Extract<ContentBlock, { type: 'text' }>).text)
					.join('\n');
				let sentMessageId: string | undefined;
				if (text) {
					const res = await chat.send('default', text);
					sentMessageId = res?.messageId;
				}
				memory.add('assistant', content, sentMessageId);
				break;
			}

			memory.add('assistant', content);

			const results: ContentBlock[] = [];
			let shouldBreak = false;

			for (const tu of toolUses) {
				const tool = tools.find(t => t.name === tu.name);
				if (!tool) {
					results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}` });
					continue;
				}
				log.info(`tool:${tu.name}`, { input: JSON.stringify(tu.input) });
				let { content, isError, signal } = await tool.call(tu.input);
				if (content.length > TOOL_OUTPUT_MAX_CHARS) {
					const preview = content.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
					const size = content.length >= 1000 ? Math.round(content.length / 1000) + 'k' : String(content.length);
					content = `Error: content too large: ${size} chars (limit: ${TOOL_OUTPUT_MAX_CHARS / 1000}k). Use more targeted commands.\n\nFirst ${TOOL_OUTPUT_PREVIEW_CHARS} chars:\n${preview}`;
					isError = true;
				}
				log.info(`tool:${tu.name}`, { result: isError ? 'error' : 'ok' });
				results.push({ type: 'tool_result', tool_use_id: tu.id, content });
				if (signal === 'restart') { shouldBreak = true; break; }
			}

			memory.add('user', results);
			if (shouldBreak) {
				await chat.typing(false);
				break;
			}
		}
	} catch (e) {
		// Ensure typing is turned off on error
		await chat.typing(false).catch(() => {});
		throw e;
	}
}
