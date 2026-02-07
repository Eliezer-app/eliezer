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

/**
 * Summarize a group of messages using the LLM.
 */
export async function summarizeGroup(group: Group, llm: LLMBase, promptsDir: string, priorContext?: string): Promise<string> {
	const timestamp = new Date(group.messages[0].created_at * 1000).toISOString().slice(0, 16);
	const formatted = JSON.stringify(group.messages.map(m => {
		const ts = new Date(m.created_at * 1000).toISOString().slice(0, 19);
		const role = m.role === 'assistant' ? 'agent' : 'user';
		return formatForSummary(m.content, role, ts);
	}).flat(), null, 2);

	let system = readFileSync(`${promptsDir}/compaction.md`, 'utf-8').trim().replace('{{timestamp}}', timestamp);
	if (priorContext) system += `\n\n# Previous context (for reference only — compress only the messages below, not this context)\n${priorContext}`;

	const response = await llm.call(
		[{ role: 'user', content: formatted }],
		system,
	);

	const text = response.content
		.filter(b => b.type === 'text')
		.map(b => (b as Extract<typeof b, { type: 'text' }>).text)
		.join('\n');

	return text || `[${timestamp}] (empty summary)`;
}

/**
 * Compress a group: summarize and write context_content to DB.
 */
export async function compressGroup(db: Database.Database, group: Group, llm: LLMBase, promptsDir: string, priorContext?: string): Promise<{ tokensBefore: number; tokensAfter: number }> {
	const tokensBefore = group.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
	const summary = await summarizeGroup(group, llm, promptsDir, priorContext);
	const tokensAfter = estimateTokens(summary);

	const anchor = group.messages[group.messages.length - 1];

	const tx = db.transaction(() => {
		// Mark all messages in group as skipped
		const skip = db.prepare("UPDATE messages SET context_content = '' WHERE rowid = ?");
		for (const m of group.messages) {
			skip.run(m.rowid);
		}
		// Set anchor to the summary
		db.prepare('UPDATE messages SET context_content = ? WHERE rowid = ?').run(summary, anchor.rowid);
		// Log
		db.prepare(
			'INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES (?, ?, ?, ?, ?)'
		).run('compress', group.start, group.end, tokensBefore, tokensAfter);
	});
	tx();

	return { tokensBefore, tokensAfter };
}

/**
 * Compress multiple groups in a single LLM call. Used for idle compaction.
 */
export async function compressGroups(db: Database.Database, groups: Group[], llm: LLMBase, promptsDir: string): Promise<{ tokensBefore: number; tokensAfter: number }> {
	const allMessages = groups.flatMap(g => g.messages);
	const tokensBefore = allMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

	const timestamp = new Date(allMessages[0].created_at * 1000).toISOString().slice(0, 16);
	const formatted = JSON.stringify(allMessages.map(m => {
		const ts = new Date(m.created_at * 1000).toISOString().slice(0, 19);
		const role = m.role === 'assistant' ? 'agent' : 'user';
		return formatForSummary(m.content, role, ts);
	}).flat(), null, 2);

	const system = readFileSync(`${promptsDir}/compaction.md`, 'utf-8').trim().replace('{{timestamp}}', timestamp);
	const response = await llm.call([{ role: 'user', content: formatted }], system);
	const summary = response.content
		.filter(b => b.type === 'text')
		.map(b => (b as Extract<typeof b, { type: 'text' }>).text)
		.join('\n') || `[${timestamp}] (empty summary)`;

	const tokensAfter = estimateTokens(summary);
	const anchor = allMessages[allMessages.length - 1];

	const tx = db.transaction(() => {
		const skip = db.prepare("UPDATE messages SET context_content = '' WHERE rowid = ?");
		for (const m of allMessages) skip.run(m.rowid);
		db.prepare('UPDATE messages SET context_content = ? WHERE rowid = ?').run(summary, anchor.rowid);
		db.prepare(
			'INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES (?, ?, ?, ?, ?)'
		).run('compress', groups[0].start, groups[groups.length - 1].end, tokensBefore, tokensAfter);
	});
	tx();

	return { tokensBefore, tokensAfter };
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

Current memory.md:
${currentMemory || '(empty)'}

Summaries being dropped:
${summaries.join('\n\n')}

Output the updated memory.md content. Keep it concise and well-organized.`,
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
 * Get all compacted (non-archived) summaries for the system prompt.
 */
export function getCompactedSummaries(db: Database.Database): string[] {
	const rows = db.prepare(
		"SELECT context_content FROM messages WHERE context_content IS NOT NULL AND context_content != '' AND archived_at IS NULL ORDER BY rowid"
	).all() as Array<{ context_content: string }>;
	return rows.map(r => r.context_content);
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
