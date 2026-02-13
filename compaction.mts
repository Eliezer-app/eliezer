import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { encoding_for_model } from 'tiktoken';
import { LLMBase } from './llm.mts';
import { Logger } from './log.mts';

const enc = encoding_for_model('gpt-4o');

const log = new Logger({ module: 'Compaction' });

export interface MessageRow {
	rowid: number;
	chat_message_id: string;
	role: string;
	content: string;
	created_at: number;
	archived: number;
}

/**
 * Format epoch seconds as ISO 8601 with timezone offset.
 * e.g. 2026-02-06T08:46-08:00
 */
export function formatTimestamp(epoch: number, timezone: string): string {
	const d = new Date(epoch * 1000);
	const parts = new Intl.DateTimeFormat('sv-SE', {
		timeZone: timezone,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false,
	}).formatToParts(d);
	const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
	const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
	const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
	const localMs = new Date(local + 'Z').getTime();
	const offsetMin = (localMs - utc) / 60000;
	const sign = offsetMin >= 0 ? '+' : '-';
	const absMin = Math.abs(offsetMin);
	const oh = String(Math.floor(absMin / 60)).padStart(2, '0');
	const om = String(absMin % 60).padStart(2, '0');
	return `${local}${sign}${oh}:${om}`;
}

export interface Group {
	start: number; // first rowid
	end: number;   // last rowid
	messages: MessageRow[];
}

/**
 * Detect groups of unarchived messages by time gaps.
 * A gap > gapSeconds between consecutive messages starts a new group.
 */
function hasToolResult(content: string): boolean {
	try {
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed.some((b: any) => b.type === 'tool_result');
	} catch {}
	return false;
}

export function identifyGroups(db: Database.Database, gapSeconds: number, includeArchived = false): Group[] {
	const rows = db.prepare(
		includeArchived
			? 'SELECT rowid, chat_message_id, role, content, created_at, archived FROM messages ORDER BY rowid'
			: 'SELECT rowid, chat_message_id, role, content, created_at, archived FROM messages WHERE NOT archived ORDER BY rowid'
	).all() as MessageRow[];

	if (!rows.length) return [];

	const groups: Group[] = [];
	let current: MessageRow[] = [rows[0]];

	for (let i = 1; i < rows.length; i++) {
		const gap = rows[i].created_at - rows[i - 1].created_at > gapSeconds;
		const isToolResult = hasToolResult(rows[i].content);
		if (gap && !isToolResult) {
			groups.push({ start: current[0].rowid, end: current[current.length - 1].rowid, messages: current });
			current = [];
		}
		current.push(rows[i]);
	}
	groups.push({ start: current[0].rowid, end: current[current.length - 1].rowid, messages: current });

	return groups;
}

/**
 * Count tokens using tiktoken (cl200k_base, GPT-4o encoding).
 */
export function estimateTokens(text: string): number {
	return enc.encode(text).length;
}

function compactionInstructions(messageCount: number): string {
	const lo = Math.max(3, Math.round(messageCount / 20));
	const hi = Math.max(lo + 2, Math.round(messageCount / 6));
	return `

CRITICAL: You MUST output ONLY a valid JSON array. No prose, no markdown, no explanation.

Each entry summarizes a stretch of conversation. You decide the granularity.
Group related exchanges into one summary when they share a topic. Split when the topic changes.

{"entries": [
  {"time":"2025-05-14T10:32","role":"agent","summary":"Read config.mts, edited DB init to add migration"},
  {"time":"2025-05-14T10:37","role":"user","summary":"Corrected: use tabs not spaces. Prefers minimal diffs."},
  ...
]}

- "time": timestamp of the LAST message covered (copy from input, truncate to minutes)
- "role": "agent" or "user". Alternate roles
- Chronological order, every input message must be covered
- Be concise but preserve decisions, corrections, and intent
- You are compressing ${messageCount} messages. Aim for ${lo}-${hi} entries

Output ONLY the JSON array. Nothing else.`;
}

interface SummaryEntry {
	time: string;
	role: string;
	summary: string;
}

/**
 * Parse structured JSON output from compaction LLM.
 * Falls back to a single entry if parsing fails.
 */
function parseSummaryEntries(text: string, fallbackTime: string): SummaryEntry[] {
	try {
		const clean = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
		let parsed = JSON.parse(clean);
		// Unwrap {anySingleKey: [...]}
		if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
			const keys = Object.keys(parsed);
			if (keys.length === 1 && Array.isArray(parsed[keys[0]])) parsed = parsed[keys[0]];
		}
		if (Array.isArray(parsed) && parsed.length > 0) return parsed;
	} catch {}
	return [{ time: fallbackTime, role: 'agent', summary: text }];
}

/**
 * Format messages for the compaction LLM.
 */
function formatMessages(messages: MessageRow[]): string {
	return JSON.stringify(messages.map(m => {
		const ts = new Date(m.created_at * 1000).toISOString().slice(0, 19);
		const role = m.role === 'assistant' ? 'agent' : 'user';
		return formatForSummary(m.content, role, ts);
	}).flat(), null, 2);
}

/**
 * Build compaction system prompt from user-editable file only.
 */
function buildCompactionSystemPrompt(promptsDir: string, priorContext?: string): string {
	let system = readFileSync(`${promptsDir}/compaction.md`, 'utf-8').trim();
	if (priorContext) system += `\n\n# Previous context (for reference only — compress only the messages below, not this context)\n${priorContext}`;
	return system;
}

/**
 * Parse a timestamp from LLM output into epoch seconds.
 */
function parseTimestamp(timeStr: string): number {
	const hasOffset = /[+-]\d{2}:\d{2}$/.test(timeStr) || timeStr.endsWith('Z');
	return Math.floor(new Date(hasOffset ? timeStr : timeStr + 'Z').getTime() / 1000);
}

/**
 * Call compaction LLM and parse structured entries.
 * Format instructions go in the user message (not system) so models like Kimi K2.5 can't ignore them.
 */
async function callCompactionLLM(messages: MessageRow[], llm: LLMBase, promptsDir: string, timezone: string, priorContext?: string): Promise<SummaryEntry[]> {
	const formatted = formatMessages(messages);
	const system = buildCompactionSystemPrompt(promptsDir, priorContext);
	const userContent = formatted + '\n\n' + compactionInstructions(messages.length);
	log.debug('calling LLM', { messages: String(messages.length), chars: String(userContent.length) });
	const response = await llm.call([{ role: 'user', content: userContent }], system, [], undefined, true);
	const text = response.content
		.filter(b => b.type === 'text')
		.map(b => (b as Extract<typeof b, { type: 'text' }>).text)
		.join('\n');
	const fallbackTime = formatTimestamp(messages[messages.length - 1].created_at, timezone);
	return parseSummaryEntries(text, fallbackTime);
}

/**
 * Write compaction results: INSERT summaries into compacted table, archive source messages.
 */
function writeCompacted(db: Database.Database, messages: MessageRow[], entries: SummaryEntry[]): number {
	const tx = db.transaction(() => {
		const insertStmt = db.prepare(
			'INSERT INTO compacted (role, summary, created_at) VALUES (?, ?, ?)'
		);
		for (const e of entries) {
			const role = e.role === 'user' ? 'user' : 'assistant';
			insertStmt.run(role, e.summary, parseTimestamp(e.time));
		}
		db.prepare(
			'UPDATE messages SET archived = 1 WHERE rowid BETWEEN ? AND ?'
		).run(messages[0].rowid, messages[messages.length - 1].rowid);
	});
	tx();
	log.debug('wrote compacted', { entries: String(entries.length), archived: String(messages.length) });
	return entries.length;
}

export interface CompactionResult {
	tokensBefore: number;
	tokensAfter: number;
	groups: number;
	messages: number;
	anchors: number;
}

/**
 * Compress a single group: emergency compaction with prior context.
 */
export async function compressGroup(db: Database.Database, group: Group, llm: LLMBase, promptsDir: string, timezone: string, priorContext?: string): Promise<CompactionResult> {
	const tokensBefore = group.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
	const entries = await callCompactionLLM(group.messages, llm, promptsDir, timezone, priorContext);
	const tokensAfter = entries.reduce((sum, e) => sum + estimateTokens(e.summary), 0);

	const anchors = writeCompacted(db, group.messages, entries);
	db.prepare(
		'INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES (?, ?, ?, ?, ?)'
	).run('compress', group.start, group.end, tokensBefore, tokensAfter);

	return { tokensBefore, tokensAfter, groups: 1, messages: group.messages.length, anchors };
}

export const BATCH_CHARS = 400_000;

/**
 * Compress multiple groups, batched by total content size.
 * Cuts at group boundaries so no group is split.
 */
export async function compressGroups(db: Database.Database, groups: Group[], llm: LLMBase, promptsDir: string, timezone: string): Promise<CompactionResult> {
	const batches: Group[][] = [];
	let current: Group[] = [];
	let chars = 0;
	for (const g of groups) {
		const groupChars = g.messages.reduce((sum, m) => sum + m.content.length, 0);
		if (chars > 0 && chars + groupChars > BATCH_CHARS) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(g);
		chars += groupChars;
	}
	if (current.length) batches.push(current);

	log.debug('compressing', { batches: String(batches.length), groups: String(groups.length) });
	let totalTokensBefore = 0, totalTokensAfter = 0, totalAnchors = 0, totalMessages = 0;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const msgs = batch.flatMap(g => g.messages);
		const tokensBefore = msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
		log.debug('batch', { batch: `${i + 1}/${batches.length}`, messages: String(msgs.length), tokens: String(tokensBefore) });
		const entries = await callCompactionLLM(msgs, llm, promptsDir, timezone);
		const tokensAfter = entries.reduce((sum, e) => sum + estimateTokens(e.summary), 0);
		const anchors = writeCompacted(db, msgs, entries);
		db.prepare(
			'INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES (?, ?, ?, ?, ?)'
		).run('compress', batch[0].start, batch[batch.length - 1].end, tokensBefore, tokensAfter);
		totalTokensBefore += tokensBefore;
		totalTokensAfter += tokensAfter;
		totalAnchors += anchors;
		totalMessages += msgs.length;
	}

	return { tokensBefore: totalTokensBefore, tokensAfter: totalTokensAfter, groups: groups.length, messages: totalMessages, anchors: totalAnchors };
}

/**
 * Distill oldest compacted summaries into memory.md.
 */
export async function distillToMemory(
	db: Database.Database, llm: LLMBase, memoryPath: string, summaries: string[],
): Promise<void> {
	log.debug('distilling', { summaries: String(summaries.length) });
	let currentMemory = '';
	try { currentMemory = readFileSync(memoryPath, 'utf-8'); } catch {}

	const response = await llm.call(
		[{
			role: 'user',
			content: `Here are old conversation summaries about to be dropped from context.
Extract any facts worth remembering permanently:
- User preferences and decisions
- Architecture and design choices
- Codebase patterns and conventions
- External service details (URLs, APIs, credentials shape)
- Key dates, chronology

Current memory.md:
${currentMemory || '(empty)'}

Summaries being dropped:
${summaries.join('\n\n')}

Output the updated memory.md content. Keep it well-organized.`,
		}],
		'You are a memory distiller. Merge new insights into the existing memory document. Deduplicate. Remove anything outdated. Output only the updated memory.md content, no explanation.',
	);

	const text = response.content
		.filter(b => b.type === 'text')
		.map(b => (b as Extract<typeof b, { type: 'text' }>).text)
		.join('\n');

	if (text.trim()) {
		writeFileSync(memoryPath, text.trim() + '\n');
	}
}

/**
 * Get all compacted (non-archived) summaries.
 */
export function getCompactedSummaries(db: Database.Database): Array<{ role: string; summary: string; created_at: number }> {
	return db.prepare(
		'SELECT role, summary, created_at FROM compacted WHERE NOT archived ORDER BY id'
	).all() as Array<{ role: string; summary: string; created_at: number }>;
}

/**
 * Get uncompressed groups (eligible for compression).
 * identifyGroups already filters to unarchived messages.
 */
export function getUncompressedGroups(db: Database.Database, gapSeconds: number): Group[] {
	return identifyGroups(db, gapSeconds);
}

/**
 * Truncate message content for the summarization prompt.
 */
function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatForSummary(content: string, role: string, ts: string): Array<Record<string, string>> {
	try {
		const blocks = JSON.parse(content);
		if (Array.isArray(blocks)) {
			const entries: Array<Record<string, string>> = [];
			for (const b of blocks) {
				if (b.type === 'reasoning') continue;
				if (b.type === 'text') entries.push({ role, time: ts, type: 'response', content: truncate(b.text, 2000) });
				if (b.type === 'tool_use') entries.push({ role, time: ts, type: 'tool_call', tool: b.name, input: truncate(JSON.stringify(b.input), 500) });
				if (b.type === 'tool_result') entries.push({ role, time: ts, type: 'tool_result', content: truncate(b.content || '', 500) });
			}
			return entries;
		}
	} catch {}
	// Extract user message from event wrapper: "Event: chat:user_message\n{...\"content\":\"actual text\"}"
	const eventMatch = content.match(/^Event: \S+\n(.+)$/s);
	if (eventMatch) {
		try {
			const payload = JSON.parse(eventMatch[1]);
			if (payload.content) return [{ role, time: ts, type: 'message', content: truncate(payload.content, 2000) }];
		} catch {}
	}
	return [{ role, time: ts, type: 'message', content: truncate(content, 2000) }];
}

/**
 * Query memory stats from DB.
 */
export interface CompactorConfig {
	tokenBudget: number;
	groupGapSeconds: number;
	flowLimitSeconds: number;
	promptsDir: string;
}

/** Opaque handle returned by prepare(). */
export interface CompactionPlan {
	readonly _brand: 'CompactionPlan';
}

interface CompactionPlanInternal extends CompactionPlan {
	group: Group;
	priorContext: string | undefined;
}

export class Compactor {
	private db: Database.Database;
	private llm: LLMBase;
	private timezone: string;
	private config: CompactorConfig;

	constructor(db: Database.Database, llm: LLMBase, timezone: string, config: CompactorConfig) {
		this.db = db;
		this.llm = llm;
		this.timezone = timezone;
		this.config = config;
	}

	private tokenUsage(): number {
		const rows = this.db.prepare(
			'SELECT content FROM messages WHERE NOT archived'
		).all() as Array<{ content: string }>;
		return rows.reduce((sum, r) => sum + estimateTokens(r.content), 0);
	}

	private buildPriorContext(): string | undefined {
		const parts: string[] = [];
		let mem = '';
		try { mem = readFileSync(`${this.config.promptsDir}/memory.md`, 'utf-8').trim(); } catch {}
		if (mem) parts.push(`## Memory\n${mem}`);
		const rows = getCompactedSummaries(this.db);
		if (rows.length) parts.push(`## Compacted history\n${rows.map(s => `[${s.role}] ${s.summary}`).join('\n\n')}`);
		return parts.length ? parts.join('\n\n') : undefined;
	}

	/** Check if emergency compaction is needed. Returns opaque plan or null. */
	prepare(): CompactionPlan | null {
		const { tokenBudget, groupGapSeconds } = this.config;
		if (this.tokenUsage() <= tokenBudget * 0.9) return null;
		const groups = getUncompressedGroups(this.db, groupGapSeconds);
		if (groups.length < 2) return null;
		return { _brand: 'CompactionPlan', group: groups[0], priorContext: this.buildPriorContext() } as CompactionPlanInternal;
	}

	/** Emergency compaction: compress oldest group, retrying up to 3 times on failure. */
	async compactTail(plan: CompactionPlan): Promise<CompactionResult | null> {
		const { group, priorContext } = plan as CompactionPlanInternal;
		let retries = 3;
		while (retries > 0) {
			try {
				return await compressGroup(this.db, group, this.llm, this.config.promptsDir, this.timezone, priorContext);
			} catch (e: any) {
				retries--;
				log.error('emergency compaction failed', { error: e.message, retriesLeft: String(retries) });
				if (retries === 0) {
					log.error('emergency compaction exhausted, context may exceed budget');
					return null;
				}
			}
		}
		return null;
	}

	/** Idle compaction: compress one batch of eligible groups. */
	async compact(): Promise<CompactionResult | null> {
		const { tokenBudget, groupGapSeconds, flowLimitSeconds, promptsDir } = this.config;
		const FLOW_ZONE_TOKENS = tokenBudget / 3;
		const COMPACT_MIN_TOKENS = tokenBudget / 4;

		const tokens = this.tokenUsage();
		if (tokens <= FLOW_ZONE_TOKENS) { log.debug('compact skip: tokens under threshold', { tokens: String(tokens), threshold: String(Math.floor(FLOW_ZONE_TOKENS)) }); return null; }

		const groups = getUncompressedGroups(this.db, groupGapSeconds);
		if (groups.length < 2) { log.debug('compact skip: need 2+ groups', { groups: String(groups.length) }); return null; }

		const now = Math.floor(Date.now() / 1000);
		const oldest = groups[0];
		const lastMsgTime = oldest.messages[oldest.messages.length - 1].created_at;
		if (now - lastMsgTime < flowLimitSeconds) { log.debug('compact skip: oldest group too recent', { age: String(now - lastMsgTime), limit: String(flowLimitSeconds) }); return null; }

		let flowTokens = 0;
		let cutoff = groups.length;
		for (let i = groups.length - 1; i >= 0; i--) {
			const groupTokens = groups[i].messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
			if (flowTokens + groupTokens > FLOW_ZONE_TOKENS) break;
			flowTokens += groupTokens;
			cutoff = i;
		}
		if (cutoff === 0) { log.debug('compact skip: all groups within flow budget'); return null; }
		const eligible = groups.slice(0, cutoff);
		const eligibleTokens = eligible.reduce((sum, g) => sum + g.messages.reduce((s, m) => s + estimateTokens(m.content), 0), 0);
		if (eligibleTokens < COMPACT_MIN_TOKENS) { log.debug('compact skip: eligible tokens under threshold', { tokens: String(eligibleTokens), threshold: String(Math.floor(COMPACT_MIN_TOKENS)) }); return null; }
		const batch: typeof eligible = [];
		let chars = 0;
		for (const g of eligible) {
			const groupChars = g.messages.reduce((sum, m) => sum + m.content.length, 0);
			if (chars > 0 && chars + groupChars > BATCH_CHARS) break;
			batch.push(g);
			chars += groupChars;
		}

		return compressGroups(this.db, batch, this.llm, promptsDir, this.timezone);
	}

	/** Distill oldest compacted summaries into memory.md. */
	async distill(): Promise<{ distilled: number; archived: number } | null> {
		const { tokenBudget, promptsDir } = this.config;

		const rows = this.db.prepare(
			'SELECT id, summary FROM compacted WHERE NOT archived ORDER BY id'
		).all() as Array<{ id: number; summary: string }>;

		const compactedTokens = rows.reduce((sum, r) => sum + estimateTokens(r.summary), 0);
		if (compactedTokens <= tokenBudget / 3) return null;

		const half = Math.ceil(rows.length / 2);
		const toDistill = rows.slice(0, half);
		const cutoffId = toDistill[toDistill.length - 1].id;

		await distillToMemory(this.db, this.llm, `${promptsDir}/memory.md`, toDistill.map(r => r.summary));

		const archived = this.db.prepare(
			'UPDATE compacted SET archived = 1 WHERE NOT archived AND id <= ?'
		).run(cutoffId).changes;

		this.db.prepare(
			"INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES ('distill', ?, ?, ?, 0)"
		).run(toDistill[0].id, cutoffId, compactedTokens);

		return { distilled: toDistill.length, archived };
	}
}

export function getMemoryStats(db: Database.Database, memoryPath: string, tokenBudget: number, systemText: string, memoryText: string) {
	const flow = db.prepare(
		'SELECT count(*) as count FROM messages WHERE NOT archived'
	).get() as { count: number };
	const flowContent = db.prepare(
		'SELECT content FROM messages WHERE NOT archived'
	).all() as Array<{ content: string }>;
	const flowTokens = flowContent.reduce((sum, r) => sum + estimateTokens(r.content), 0);

	const compacted = db.prepare(
		'SELECT count(*) as count FROM compacted WHERE NOT archived'
	).get() as { count: number };
	const compactedContent = db.prepare(
		'SELECT summary FROM compacted WHERE NOT archived'
	).all() as Array<{ summary: string }>;
	const compactedTokens = compactedContent.reduce((sum, r) => sum + estimateTokens(r.summary), 0);

	const compactedGroups = db.prepare(
		"SELECT count(DISTINCT group_end) as count FROM compaction_log WHERE op = 'compress'"
	).get() as { count: number };

	const archived = db.prepare(
		'SELECT count(*) as count FROM messages WHERE archived'
	).get() as { count: number };

	const compressions = db.prepare(
		"SELECT created_at FROM compaction_log WHERE op = 'compress' ORDER BY id DESC LIMIT 10"
	).all() as Array<{ created_at: string }>;

	const distillations = db.prepare(
		"SELECT created_at FROM compaction_log WHERE op = 'distill' ORDER BY id DESC LIMIT 10"
	).all() as Array<{ created_at: string }>;

	const systemTokens = estimateTokens(systemText);
	const memoryTokens = estimateTokens(memoryText);
	const used = systemTokens + memoryTokens + compactedTokens + flowTokens;

	return {
		context: {
			system:    { tokens: systemTokens,    pct: Math.round(systemTokens / tokenBudget * 100) },
			memory:    { tokens: memoryTokens,    pct: Math.round(memoryTokens / tokenBudget * 100) },
			compacted: { tokens: compactedTokens, pct: Math.round(compactedTokens / tokenBudget * 100), groups: compactedGroups.count },
			flow:      { tokens: flowTokens,      pct: Math.round(flowTokens / tokenBudget * 100), messages: flow.count },
			total:     { tokens: used,             pct: Math.round(used / tokenBudget * 100) },
			budget:    tokenBudget,
		},
		archived: { messages: archived.count },
		ops: {
			compressions: compressions.map(r => r.created_at),
			distillations: distillations.map(r => r.created_at),
		},
	};
}
