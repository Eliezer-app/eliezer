import { readFileSync, writeFileSync } from 'fs';
import { LLMBase } from './llm.mts';
import { Logger } from './log.mts';
import { Memory, MessageRow, Group, estimateTokens } from './memory.mts';

const log = new Logger({ module: 'Compaction' });

/**
 * Truncate message content for the summarization prompt.
 */
function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatLine(content: string, role: string, ts: string): string[] {
	const tag = role === 'user' ? 'User' : 'Agent';
	try {
		const blocks = JSON.parse(content);
		if (Array.isArray(blocks)) {
			const lines: string[] = [];
			for (const b of blocks) {
				if (b.type === 'reasoning') continue;
				if (b.type === 'text') lines.push(`[${ts}:${tag}:response] ${truncate(b.text, 2000)}`);
				if (b.type === 'tool_use') lines.push(`[${ts}:${tag}:tool_call] ${b.name} ${truncate(JSON.stringify(b.input), 500)}`);
				if (b.type === 'tool_result') lines.push(`[${ts}:${tag}:tool_result] ${truncate(b.content || '', 500)}`);
			}
			return lines;
		}
	} catch {}
	const eventMatch = content.match(/^Event: \S+\n(.+)$/s);
	if (eventMatch) {
		try {
			const payload = JSON.parse(eventMatch[1]);
			if (payload.content) return [`[${ts}:${tag}:message] ${truncate(payload.content, 2000)}`];
		} catch {}
	}
	return [`[${ts}:${tag}:message] ${truncate(content, 2000)}`];
}

/**
 * Format messages for the compaction LLM.
 */
function formatMessages(messages: MessageRow[]): string {
	return messages.flatMap(m => {
		const ts = new Date(m.created_at * 1000).toISOString().slice(0, 16);
		const role = m.role === 'assistant' ? 'agent' : 'user';
		return formatLine(m.content, role, ts);
	}).join('\n');
}

/**
 * Build compaction system prompt from user-editable file only.
 */
function buildCompactionPrompts(promptsDir: string, priorContext?: string): { system: string; preamble: string } {
	const preamble = readFileSync(`${promptsDir}/compaction.md`, 'utf-8').trim();
	let system = 'You are a Context Compaction expert. Your best quality is preserving information.';
	if (priorContext) system += `\n\n# Previous context (for reference only — compress only the messages below, not this context)\n${priorContext}`;
	return { system, preamble };
}

/**
 * Call compaction LLM and return raw narrative summary.
 */
export async function callCompactionLLM(messages: MessageRow[], llm: LLMBase, promptsDir: string, priorContext?: string): Promise<string> {
	const formatted = formatMessages(messages);
	const { system, preamble } = buildCompactionPrompts(promptsDir, priorContext);
	const userContent = preamble + '\n\nCONVERSATION TO CURATE, BEGIN:\n\n' + formatted + '\n\nEND OF CONVERSATION';
	log.debug('calling LLM', { messages: String(messages.length), chars: String(userContent.length) });
	const response = await llm.call([{ role: 'user', content: userContent }], system);
	return response.content
		.filter(b => b.type === 'text')
		.map(b => (b as Extract<typeof b, { type: 'text' }>).text)
		.join('\n');
}

/**
 * Distill oldest compacted summaries into memory.md.
 */
export async function distillToMemory(
	llm: LLMBase, memoryPath: string, summaries: string[],
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

export interface CompactionResult {
	tokensBefore: number;
	tokensAfter: number;
	groups: number;
	messages: number;
	anchors: number;
}

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

export const BATCH_CHARS = 400_000;

/**
 * Compress a single group: emergency compaction with prior context.
 */
export async function compressGroup(memory: Memory, group: Group, llm: LLMBase, promptsDir: string, reason: string, tokenBudget: number, priorContext?: string): Promise<CompactionResult> {
	const tokensBefore = group.messages.reduce((sum, m) => sum + memory.messageTokens(m), 0);
	const summary = await callCompactionLLM(group.messages, llm, promptsDir, priorContext);
	const tokensAfter = estimateTokens(summary);

	memory.writeCompacted(group.messages, summary);
	memory.logCompaction('compress', group.start, group.end, tokensBefore, tokensAfter, reason, tokenBudget);

	return { tokensBefore, tokensAfter, groups: 1, messages: group.messages.length, anchors: 1 };
}

/**
 * Compress multiple groups, batched by total content size.
 * Cuts at group boundaries so no group is split.
 */
export async function compressGroups(memory: Memory, groups: Group[], llm: LLMBase, promptsDir: string, reason: string, tokenBudget: number): Promise<CompactionResult> {
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
	let totalTokensBefore = 0, totalTokensAfter = 0, totalMessages = 0;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const msgs = batch.flatMap(g => g.messages);
		const tokensBefore = msgs.reduce((sum, m) => sum + memory.messageTokens(m), 0);
		log.debug('batch', { batch: `${i + 1}/${batches.length}`, messages: String(msgs.length), tokens: String(tokensBefore) });
		const summary = await callCompactionLLM(msgs, llm, promptsDir);
		const tokensAfter = estimateTokens(summary);
		memory.writeCompacted(msgs, summary);
		memory.logCompaction('compress', batch[0].start, batch[batch.length - 1].end, tokensBefore, tokensAfter, reason, tokenBudget);
		totalTokensBefore += tokensBefore;
		totalTokensAfter += tokensAfter;
		totalMessages += msgs.length;
	}

	return { tokensBefore: totalTokensBefore, tokensAfter: totalTokensAfter, groups: groups.length, messages: totalMessages, anchors: batches.length };
}

export class Compactor {
	private memory: Memory;
	private llm: LLMBase;
	private config: CompactorConfig;

	constructor(memory: Memory, llm: LLMBase, config: CompactorConfig) {
		this.memory = memory;
		this.llm = llm;
		this.config = config;
	}

	/** Check if emergency compaction is needed. Returns opaque plan or null. */
	prepare(): CompactionPlan | null {
		const { tokenBudget, groupGapSeconds } = this.config;
		if (this.memory.tokenUsage() <= tokenBudget * 0.9) return null;
		const groups = this.memory.getUncompressedGroups(groupGapSeconds);
		if (groups.length < 2) return null;
		return { _brand: 'CompactionPlan', group: groups[0], priorContext: this.memory.buildPriorContext(this.config.promptsDir) } as CompactionPlanInternal;
	}

	/** Emergency compaction: compress oldest group, retrying up to 3 times on failure. */
	async compactTail(plan: CompactionPlan): Promise<CompactionResult | null> {
		const { group, priorContext } = plan as CompactionPlanInternal;
		const reason = `emergency, ${group.messages.length} messages`;
		let retries = 3;
		while (retries > 0) {
			try {
				return await compressGroup(this.memory, group, this.llm, this.config.promptsDir, reason, this.config.tokenBudget, priorContext);
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

		const tokens = this.memory.tokenUsage();
		if (tokens <= FLOW_ZONE_TOKENS) { log.debug('compact skip: tokens under threshold', { tokens: String(tokens), threshold: String(Math.floor(FLOW_ZONE_TOKENS)) }); return null; }

		const groups = this.memory.getUncompressedGroups(groupGapSeconds);
		if (groups.length < 2) { log.debug('compact skip: need 2+ groups', { groups: String(groups.length) }); return null; }

		const now = Math.floor(Date.now() / 1000);
		const oldest = groups[0];
		const lastMsgTime = oldest.messages[oldest.messages.length - 1].created_at;
		if (now - lastMsgTime < flowLimitSeconds) { log.debug('compact skip: oldest group too recent', { age: String(now - lastMsgTime), limit: String(flowLimitSeconds) }); return null; }

		let flowTokens = 0;
		let cutoff = groups.length;
		for (let i = groups.length - 1; i >= 0; i--) {
			const groupTokens = groups[i].messages.reduce((sum, m) => sum + this.memory.messageTokens(m), 0);
			if (flowTokens + groupTokens > FLOW_ZONE_TOKENS) break;
			flowTokens += groupTokens;
			cutoff = i;
		}
		if (cutoff === 0) { log.debug('compact skip: all groups within flow budget'); return null; }
		const eligible = groups.slice(0, cutoff);
		const eligibleTokens = eligible.reduce((sum, g) => sum + g.messages.reduce((s, m) => s + this.memory.messageTokens(m), 0), 0);
		if (eligibleTokens < COMPACT_MIN_TOKENS) { log.debug('compact skip: eligible tokens under threshold', { tokens: String(eligibleTokens), threshold: String(Math.floor(COMPACT_MIN_TOKENS)) }); return null; }
		const batch: typeof eligible = [];
		let chars = 0;
		for (const g of eligible) {
			const groupChars = g.messages.reduce((sum, m) => sum + m.content.length, 0);
			if (chars > 0 && chars + groupChars > BATCH_CHARS) break;
			batch.push(g);
			chars += groupChars;
		}

		const batchMessages = batch.reduce((sum, g) => sum + g.messages.length, 0);
		const reason = `idle, ${batch.length} groups, ${batchMessages} messages`;
		return compressGroups(this.memory, batch, this.llm, promptsDir, reason, tokenBudget);
	}

	/** Distill oldest compacted summaries into memory.md. */
	async distill(): Promise<{ distilled: number; archived: number } | null> {
		const { tokenBudget, promptsDir } = this.config;

		const rows = this.memory.getUnarchivedCompacted();

		const compactedTokens = rows.reduce((sum, r) => sum + estimateTokens(r.summary), 0);
		if (compactedTokens <= tokenBudget / 3) return null;

		const half = Math.ceil(rows.length / 2);
		const toDistill = rows.slice(0, half);
		const cutoffId = toDistill[toDistill.length - 1].id;

		await distillToMemory(this.llm, `${promptsDir}/memory.md`, toDistill.map(r => r.summary));

		const archived = this.memory.archiveCompacted(cutoffId);
		this.memory.logCompaction('distill', toDistill[0].id, cutoffId, compactedTokens, 0, `${toDistill.length} summaries`, tokenBudget);

		return { distilled: toDistill.length, archived };
	}
}
