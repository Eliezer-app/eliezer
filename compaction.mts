import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { LLMBase } from './llm.mts';

export interface MessageRow {
	rowid: number;
	chat_message_id: string;
	role: string;
	content: string;
	created_at: number;
	context_content: string | null;
	archived_at: string | null;
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
 * Detect groups of related messages by time gaps.
 * A gap > gapSeconds between consecutive messages starts a new group.
 */
export function identifyGroups(db: Database.Database, gapSeconds: number): Group[] {
	const rows = db.prepare(
		'SELECT rowid, chat_message_id, role, content, created_at, context_content, archived_at FROM messages ORDER BY rowid'
	).all() as MessageRow[];

	if (!rows.length) return [];

	const groups: Group[] = [];
	let current: MessageRow[] = [rows[0]];

	for (let i = 1; i < rows.length; i++) {
		if (rows[i].created_at - rows[i - 1].created_at > gapSeconds) {
			groups.push({ start: current[0].rowid, end: current[current.length - 1].rowid, messages: current });
			current = [];
		}
		current.push(rows[i]);
	}
	groups.push({ start: current[0].rowid, end: current[current.length - 1].rowid, messages: current });

	return groups;
}

/**
 * Estimate token count from text (~4 chars per token).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function anchoringInstructions(messageCount: number): string {
	const lo = Math.max(3, Math.round(messageCount / 20));
	const hi = Math.max(lo + 2, Math.round(messageCount / 6));
	return `

CRITICAL: You MUST output ONLY a valid JSON array. No prose, no markdown, no explanation.

Each entry anchors to a database message by timestamp and role. All messages
from the previous anchor up to this one will be replaced by your summary.

You decide the granularity. Group related exchanges into one summary when they
share a topic. Split when the topic changes.

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
 * Find the message closest to a timestamp with matching role.
 * Falls back to nearest message of any role if no role match found.
 */
function findAnchorMessage(timeStr: string, role: string, messages: MessageRow[]): MessageRow {
	// Handle offset-aware (2026-02-06T08:46-08:00), UTC (2025-05-14T10:32:00Z), or bare (2025-05-14T10:32)
	const hasOffset = /[+-]\d{2}:\d{2}$/.test(timeStr) || timeStr.endsWith('Z');
	const target = Math.floor(new Date(hasOffset ? timeStr : timeStr + 'Z').getTime() / 1000);
	const dbRole = role === 'user' ? 'user' : 'assistant';
	let bestWithRole: MessageRow | null = null;
	let bestWithRoleDist = Infinity;
	let bestAny = messages[messages.length - 1];
	let bestAnyDist = Infinity;
	for (const m of messages) {
		const dist = Math.abs(m.created_at - target);
		if (m.role === dbRole && dist < bestWithRoleDist) { bestWithRole = m; bestWithRoleDist = dist; }
		if (dist < bestAnyDist) { bestAny = m; bestAnyDist = dist; }
	}
	return bestWithRole ?? bestAny;
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
 * Call compaction LLM and parse structured entries.
 * Format instructions go in the user message (not system) so models like Kimi K2.5 can't ignore them.
 */
async function callCompactionLLM(messages: MessageRow[], llm: LLMBase, promptsDir: string, timezone: string, priorContext?: string): Promise<SummaryEntry[]> {
	const formatted = formatMessages(messages, timezone);
	const system = buildCompactionSystemPrompt(promptsDir, priorContext);
	const userContent = formatted + '\n\n' + anchoringInstructions(messages.length);
	const response = await llm.call([{ role: 'user', content: userContent }], system, [], undefined, true);
	const text = response.content
		.filter(b => b.type === 'text')
		.map(b => (b as Extract<typeof b, { type: 'text' }>).text)
		.join('\n');
	const fallbackTime = formatTimestamp(messages[messages.length - 1].created_at, timezone);
	return parseSummaryEntries(text, fallbackTime);
}

/**
 * Write anchored summaries to DB. Each entry anchors to the nearest message;
 * all messages between anchors get context_content = '' (skipped).
 */
function writeAnchors(db: Database.Database, messages: MessageRow[], entries: SummaryEntry[]): number {
	// Resolve anchors and sort by rowid
	const anchors = entries
		.map(e => ({ entry: e, anchor: findAnchorMessage(e.time, e.role, messages) }))
		.sort((a, b) => a.anchor.rowid - b.anchor.rowid);

	// Deduplicate: if two entries resolve to the same message, merge summaries
	const deduped: typeof anchors = [];
	for (const a of anchors) {
		const prev = deduped[deduped.length - 1];
		if (prev && prev.anchor.rowid === a.anchor.rowid) {
			prev.entry = { ...prev.entry, summary: prev.entry.summary + '\n' + a.entry.summary };
		} else {
			deduped.push(a);
		}
	}

	const tx = db.transaction(() => {
		const skip = db.prepare("UPDATE messages SET context_content = '' WHERE rowid = ?");
		const setAnchor = db.prepare('UPDATE messages SET context_content = ? WHERE rowid = ?');
		for (const m of messages) skip.run(m.rowid);
		for (const { entry, anchor } of deduped) setAnchor.run(entry.summary, anchor.rowid);
	});
	tx();

	return deduped.length;
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

	const anchors = writeAnchors(db, group.messages, entries);
	db.prepare(
		'INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES (?, ?, ?, ?, ?)'
	).run('compress', group.start, group.end, tokensBefore, tokensAfter);

	return { tokensBefore, tokensAfter, groups: 1, messages: group.messages.length, anchors };
}

const BATCH_SIZE = 100;

/**
 * Compress multiple groups, batched to ~BATCH_SIZE messages per LLM call.
 * Cuts at group boundaries so no group is split.
 */
export async function compressGroups(db: Database.Database, groups: Group[], llm: LLMBase, promptsDir: string, timezone: string): Promise<CompactionResult> {
	const batches: Group[][] = [];
	let current: Group[] = [];
	let count = 0;
	for (const g of groups) {
		if (count > 0 && count + g.messages.length > BATCH_SIZE) {
			batches.push(current);
			current = [];
			count = 0;
		}
		current.push(g);
		count += g.messages.length;
	}
	if (current.length) batches.push(current);

	let totalTokensBefore = 0, totalTokensAfter = 0, totalAnchors = 0, totalMessages = 0;
	for (const batch of batches) {
		const msgs = batch.flatMap(g => g.messages);
		const tokensBefore = msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
		const entries = await callCompactionLLM(msgs, llm, promptsDir, timezone);
		const tokensAfter = entries.reduce((sum, e) => sum + estimateTokens(e.summary), 0);
		const anchors = writeAnchors(db, msgs, entries);
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
 * Archive compacted groups that have been distilled into memory.md.
 */
export function archiveGroups(db: Database.Database, groups: Group[]): void {
	const tx = db.transaction(() => {
		const stmt = db.prepare("UPDATE messages SET archived_at = datetime('now') WHERE rowid = ?");
		for (const g of groups) {
			for (const m of g.messages) {
				stmt.run(m.rowid);
			}
		}
		if (groups.length) {
			db.prepare(
				'INSERT INTO compaction_log (op, group_start, group_end) VALUES (?, ?, ?)'
			).run('archive', groups[0].start, groups[groups.length - 1].end);
		}
	});
	tx();
}

/**
 * Get all compacted (non-archived) summaries with their roles.
 */
export function getCompactedSummaries(db: Database.Database): Array<{ role: string; summary: string; created_at: number }> {
	return db.prepare(
		"SELECT role, context_content as summary, created_at FROM messages WHERE context_content IS NOT NULL AND context_content != '' AND archived_at IS NULL ORDER BY rowid"
	).all() as Array<{ role: string; summary: string; created_at: number }>;
}

/**
 * Get uncompressed groups (eligible for compression).
 * Only returns groups where all messages have context_content IS NULL.
 */
export function getUncompressedGroups(db: Database.Database, gapSeconds: number): Group[] {
	return identifyGroups(db, gapSeconds).filter(g =>
		g.messages.every(m => m.context_content === null && m.archived_at === null)
	);
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
export function getMemoryStats(db: Database.Database, memoryPath: string, tokenBudget: number, systemChars: number, memoryChars: number) {
	const flow = db.prepare(
		"SELECT count(*) as count, sum(length(content)) as size FROM messages WHERE context_content IS NULL AND archived_at IS NULL"
	).get() as { count: number; size: number | null };

	const compacted = db.prepare(
		"SELECT count(*) as count, sum(length(context_content)) as size FROM messages WHERE context_content IS NOT NULL AND context_content != '' AND archived_at IS NULL"
	).get() as { count: number; size: number | null };

	const compactedOriginal = db.prepare(
		"SELECT sum(length(content)) as size FROM messages WHERE context_content IS NOT NULL AND archived_at IS NULL"
	).get() as { size: number | null };

	const compactedGroups = db.prepare(
		"SELECT count(DISTINCT group_end) as count FROM compaction_log WHERE op = 'compress'"
	).get() as { count: number };

	const archived = db.prepare(
		"SELECT count(*) as count FROM messages WHERE archived_at IS NOT NULL"
	).get() as { count: number };

	const compressions = db.prepare(
		"SELECT created_at FROM compaction_log WHERE op = 'compress' ORDER BY id DESC LIMIT 10"
	).all() as Array<{ created_at: string }>;

	const distillations = db.prepare(
		"SELECT created_at FROM compaction_log WHERE op = 'distill' ORDER BY id DESC LIMIT 10"
	).all() as Array<{ created_at: string }>;

	const systemTokens = estimateTokens(' '.repeat(systemChars));
	const memoryTokens = estimateTokens(' '.repeat(memoryChars));
	const compactedTokens = estimateTokens(' '.repeat(compacted.size ?? 0));
	const flowTokens = estimateTokens(' '.repeat(flow.size ?? 0));
	const used = systemTokens + memoryTokens + compactedTokens + flowTokens;

	return {
		context: {
			system:    { tokens: systemTokens,    pct: Math.round(systemTokens / tokenBudget * 100) },
			memory:    { tokens: memoryTokens,    pct: Math.round(memoryTokens / tokenBudget * 100) },
			compacted: { tokens: compactedTokens, pct: Math.round(compactedTokens / tokenBudget * 100), groups: compactedGroups.count, originalTokens: estimateTokens(' '.repeat(compactedOriginal.size ?? 0)) },
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
