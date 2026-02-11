import { config } from 'dotenv';
config();
import { readFileSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { createLLM } from '../llm.mts';
import { getUncompressedGroups, formatTimestamp } from '../compaction.mts';

const db = new Database(process.env.DB_PATH as string);
const tz = process.env.USER_TZ as string;
const promptsDir = process.env.PROMPTS_DIR as string;
const llm = createLLM({
	provider: process.env.COMPACTION_LLM_PROVIDER || process.env.LLM_PROVIDER as string,
	apiKey: process.env.COMPACTION_LLM_API_KEY || process.env.LLM_API_KEY as string,
	model: process.env.COMPACTION_LLM_MODEL || process.env.LLM_MODEL as string,
	baseUrl: process.env.COMPACTION_LLM_BASE_URL || process.env.LLM_BASE_URL as string,
	timeoutMs: 240_000,
	maxTokens: 25_000,
});

const groups = getUncompressedGroups(db, 60);
if (groups.length < 2) { console.log('Need at least 2 groups'); process.exit(0); }
const toCompress = groups.slice(0, -1);
const messages = toCompress.flatMap(g => g.messages);
console.log(`${messages.length} messages to compress`);

// Collect tool_use calls keyed by id, so we can merge results inline
const toolCalls = new Map<string, { name: string; input: any }>();
for (const m of messages) {
	try {
		const blocks = JSON.parse(m.content);
		if (!Array.isArray(blocks)) continue;
		for (const b of blocks) {
			if (b.type === 'tool_use') toolCalls.set(b.id, { name: b.name, input: b.input });
		}
	} catch {}
}

function formatToolInput(input: Record<string, any>): string {
	const keys = Object.keys(input);
	if (keys.length === 1) {
		return typeof input[keys[0]] === 'string' ? input[keys[0]] : JSON.stringify(input[keys[0]]);
	}
	return keys.map(k => `${k}=${JSON.stringify(input[k])}`).join(', ');
}

function extractUserContent(raw: string): string {
	// User messages may have "Event: chat:user_message\n{...content...}" format
	const lines = raw.split('\n');
	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if (obj.content) return obj.content;
		} catch {}
	}
	return raw;
}

function formatMessage(m: typeof messages[0]): string | null {
	const ts = formatTimestamp(m.created_at, tz);
	try {
		const blocks = JSON.parse(m.content);
		if (!Array.isArray(blocks)) return `[${ts} User] ${extractUserContent(m.content)}`;
		const parts: string[] = [];
		for (const b of blocks) {
			if (b.type === 'reasoning') continue;
			if (b.type === 'text') parts.push(`[${ts} Agent] ${b.text}`);
			if (b.type === 'tool_use') continue;
			if (b.type === 'tool_result') {
				const call = toolCalls.get(b.tool_use_id);
				const name = call?.name ?? '?';
				const input = call ? formatToolInput(call.input) : '';
				parts.push(`[${ts} Agent Tool] ${name}: ${input}\n${b.content}`);
			}
		}
		if (!parts.length) return null;
		return parts.join('\n\n');
	} catch {
		return `[${ts} User] ${extractUserContent(m.content)}`;
	}
}

const formatted = messages.map(formatMessage).filter(Boolean).join('\n\n');

writeFileSync('./state/compaction-input.md', formatted);
console.log(`Input written to ./state/compaction-input.md (${formatted.length} chars)`);

const instructions = readFileSync(`${promptsDir}/compaction.md`, 'utf-8').trim();

console.log('Calling LLM...');
const userContent = `${instructions}\n\n<conversation>\n${formatted}\n</conversation>`;
const response = await llm.call([{ role: 'user', content: userContent }], 'You are a memory compaction specialist.');
const text = response.content
	.filter(b => b.type === 'text')
	.map(b => (b as any).text)
	.join('\n');

const outPath = './state/compaction-output.md';
writeFileSync(outPath, text);
console.log(`Written to ${outPath} (${text.length} chars)`);
process.exit(0);
