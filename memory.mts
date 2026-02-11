import Database from 'better-sqlite3';
import { ContentBlock, Message, LLMBase } from './llm.mts';
import { readFileSync } from 'fs';
import { Logger } from './log.mts';
import { getUncompressedGroups, getCompactedSummaries, compressGroup, compressGroups, distillToMemory, estimateTokens, formatTimestamp, BATCH_CHARS, CompactionResult } from './compaction.mts';

const log = new Logger({ module: 'Memory' });

export interface CompactionConfig {
	tokenBudget: number;
	groupGapSeconds: number;
	flowLimitSeconds: number;
	promptsDir: string;
}

export class Memory {
	private db: Database.Database;
	private compaction?: CompactionConfig;
	private timezone: string;

	constructor(db: Database.Database, timezone: string) {
		this.timezone = timezone;
		this.db = db;

		// Migrate from old schema: drop context_content/archived_at, add archived
		const cols = db.pragma('table_info(messages)') as Array<{ name: string }>;
		const colNames = new Set(cols.map(c => c.name));
		if (colNames.has('context_content')) {
			db.exec(`
				CREATE TABLE messages_new (
					chat_message_id TEXT PRIMARY KEY,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					created_at INTEGER DEFAULT (unixepoch()),
					archived INTEGER NOT NULL DEFAULT 0
				);
				INSERT INTO messages_new (chat_message_id, role, content, created_at)
					SELECT chat_message_id, role, content, created_at FROM messages;
				DROP TABLE messages;
				ALTER TABLE messages_new RENAME TO messages;
			`);
		}

		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				chat_message_id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER DEFAULT (unixepoch()),
				archived INTEGER NOT NULL DEFAULT 0
			);
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS compacted (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				summary TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				archived INTEGER NOT NULL DEFAULT 0
			);
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS compaction_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				op TEXT NOT NULL,
				group_start INTEGER,
				group_end INTEGER,
				tokens_before INTEGER,
				tokens_after INTEGER,
				created_at TEXT DEFAULT (datetime('now'))
			);
		`);
	}

	add(role: 'user' | 'assistant', content: string | ContentBlock[], chatMessageId?: string): void {
		if (typeof content === 'string' && !content.length) return;
		if (Array.isArray(content) && !content.length) return;
		const serialized = typeof content === 'string' ? content : JSON.stringify(content);
		const id = chatMessageId ?? crypto.randomUUID();
		this.db.prepare('INSERT INTO messages (chat_message_id, role, content) VALUES (?, ?, ?)').run(id, role, serialized);
	}

	/** Delete a message only if it hasn't been compacted yet. */
	deleteUncompacted(chatMessageId: string): boolean {
		return this.db.prepare(
			'DELETE FROM messages WHERE chat_message_id = ? AND NOT archived'
		).run(chatMessageId).changes > 0;
	}

	/** Compacted history formatted as text for the system prompt. */
	getCompactedHistory(): string {
		const compacted = getCompactedSummaries(this.db);
		if (!compacted.length) return '';
		const fmt = (epoch: number) => formatTimestamp(epoch, this.timezone);
		const roleLabel = (role: string) => role === 'user' ? 'User' : 'Agent';
		return compacted.map(({ role, summary, created_at }) =>
			`[:${fmt(created_at)}] ${roleLabel(role)}: ${summary}`
		).join('\n\n');
	}

	getContext(): Message[] {
		const rows = this.db.prepare(
			'SELECT role, content, created_at FROM messages WHERE NOT archived ORDER BY rowid'
		).all() as Array<{ role: string; content: string; created_at: number }>;

		const messages: Message[] = [];
		const fmt = (epoch: number) => formatTimestamp(epoch, this.timezone);

		function pushMessage(role: 'user' | 'assistant', content: string | ContentBlock[]) {
			const prev = messages[messages.length - 1];
			if (prev && prev.role === role && typeof prev.content === 'string' && typeof content === 'string') {
				prev.content += '\n\n' + content;
			} else {
				messages.push({ role, content });
			}
		}

		for (const r of rows) {
			const ts = fmt(r.created_at);
			let content: string | ContentBlock[];
			try {
				const parsed = JSON.parse(r.content);
				if (Array.isArray(parsed)) {
					// Only prepend timestamp to user messages (not tool_results, not assistant)
					const addTs = r.role === 'user' && !parsed.some((b: any) => b.type === 'tool_result');
					content = addTs ? [{ type: 'text', text: `[${ts}]` } as ContentBlock, ...parsed] : parsed;
				} else {
					content = `[${ts}] ${r.content}`;
				}
			} catch {
				content = `[${ts}] ${r.content}`;
			}
			pushMessage(r.role as 'user' | 'assistant', content);
		}

		// Drop leading messages with orphaned tool_results (no matching tool_use before them)
		while (messages.length > 0) {
			const msg = messages[0];
			if (!Array.isArray(msg.content)) break;
			const toolResults = msg.content.filter(b => b.type === 'tool_result') as
				Array<Extract<ContentBlock, { type: 'tool_result' }>>;
			if (!toolResults.length) break;
			messages.shift();
		}

		// Inject virtual tool_results for orphaned tool_use blocks (e.g. process killed mid-execution)
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
			const toolUses = msg.content.filter(b => b.type === 'tool_use') as
				Array<Extract<ContentBlock, { type: 'tool_use' }>>;
			if (!toolUses.length) continue;

			// Collect tool_result IDs from the next user message
			const next = messages[i + 1];
			const answeredIds = new Set<string>();
			if (next && next.role === 'user' && Array.isArray(next.content)) {
				for (const b of next.content) {
					if (b.type === 'tool_result') answeredIds.add((b as Extract<ContentBlock, { type: 'tool_result' }>).tool_use_id);
				}
			}

			const missing = toolUses.filter(tu => !answeredIds.has(tu.id));
			if (!missing.length) continue;

			const synthetic: ContentBlock[] = missing.map(tu => ({
				type: 'tool_result' as const,
				tool_use_id: tu.id,
				content: '(aborted)',
			}));

			if (next && next.role === 'user' && Array.isArray(next.content)) {
				next.content = [...next.content, ...synthetic];
			} else {
				// No user message follows — insert one
				messages.splice(i + 1, 0, { role: 'user', content: synthetic });
			}
		}

		return messages;
	}

	setCompactionConfig(config: CompactionConfig): void {
		this.compaction = config;
	}

	private tokenUsage(): number {
		const rows = this.db.prepare(
			'SELECT content FROM messages WHERE NOT archived'
		).all() as Array<{ content: string }>;
		return rows.reduce((sum, r) => sum + estimateTokens(r.content), 0);
	}

	/** Idle compaction: compress one batch of eligible groups per call. */
	async compact(llm: LLMBase): Promise<CompactionResult | null> {
		if (!this.compaction) throw new Error('compaction not configured');
		const { tokenBudget, groupGapSeconds, flowLimitSeconds, promptsDir } = this.compaction;

		const tokens = this.tokenUsage();
		if (tokens <= tokenBudget / 3) { log.debug('compact skip: tokens under threshold', { tokens: String(tokens), threshold: String(Math.floor(tokenBudget / 3)) }); return null; }

		const groups = getUncompressedGroups(this.db, groupGapSeconds);
		if (groups.length < 2) { log.debug('compact skip: need 2+ groups', { groups: String(groups.length) }); return null; }

		const now = Math.floor(Date.now() / 1000);
		const oldest = groups[0];
		const lastMsgTime = oldest.messages[oldest.messages.length - 1].created_at;
		if (now - lastMsgTime < flowLimitSeconds) { log.debug('compact skip: oldest group too recent', { age: String(now - lastMsgTime), limit: String(flowLimitSeconds) }); return null; }

		// Keep most recent groups totaling tokenBudget/3 in flow zone, compact the rest
		const flowBudget = tokenBudget / 3;
		let flowTokens = 0;
		let cutoff = groups.length;
		for (let i = groups.length - 1; i >= 0; i--) {
			const groupTokens = groups[i].messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
			if (flowTokens + groupTokens > flowBudget) break;
			flowTokens += groupTokens;
			cutoff = i;
		}
		if (cutoff === 0) { log.debug('compact skip: all groups within flow budget'); return null; }
		const eligible = groups.slice(0, cutoff);
		const batch: typeof eligible = [];
		let chars = 0;
		for (const g of eligible) {
			const groupChars = g.messages.reduce((sum, m) => sum + m.content.length, 0);
			if (chars > 0 && chars + groupChars > BATCH_CHARS) break;
			batch.push(g);
			chars += groupChars;
		}

		return compressGroups(this.db, batch, llm, promptsDir, this.timezone);
	}

	/** Emergency compaction: compress oldest group only, with full prior context. */
	async compactTail(llm: LLMBase): Promise<CompactionResult | null> {
		if (!this.compaction) throw new Error('compaction not configured');
		const { tokenBudget, groupGapSeconds, promptsDir } = this.compaction;

		const tokens = this.tokenUsage();
		if (tokens <= tokenBudget * 0.9) return null;

		const groups = getUncompressedGroups(this.db, groupGapSeconds);
		if (groups.length < 2) return null;

		const priorContext = this.buildPriorContext();
		return compressGroup(this.db, groups[0], llm, promptsDir, this.timezone, priorContext);
	}

	/** Distill oldest compacted summaries into memory.md when compacted zone is too large. */
	async distill(llm: LLMBase): Promise<{ distilled: number; archived: number } | null> {
		if (!this.compaction) throw new Error('compaction not configured');
		const { tokenBudget, promptsDir } = this.compaction;

		const rows = this.db.prepare(
			'SELECT id, summary FROM compacted WHERE NOT archived ORDER BY id'
		).all() as Array<{ id: number; summary: string }>;

		const compactedTokens = rows.reduce((sum, r) => sum + estimateTokens(r.summary), 0);
		if (compactedTokens <= tokenBudget / 3) return null;

		const half = Math.ceil(rows.length / 2);
		const toDistill = rows.slice(0, half);
		const cutoffId = toDistill[toDistill.length - 1].id;

		await distillToMemory(this.db, llm, `${promptsDir}/memory.md`, toDistill.map(r => r.summary));

		const archived = this.db.prepare(
			'UPDATE compacted SET archived = 1 WHERE NOT archived AND id <= ?'
		).run(cutoffId).changes;

		this.db.prepare(
			"INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES ('distill', ?, ?, ?, 0)"
		).run(toDistill[0].id, cutoffId, compactedTokens);

		return { distilled: toDistill.length, archived };
	}

	private buildPriorContext(): string | undefined {
		const parts: string[] = [];
		let mem = '';
		try { mem = readFileSync(`${this.compaction!.promptsDir}/memory.md`, 'utf-8').trim(); } catch {}
		if (mem) parts.push(`## Memory\n${mem}`);
		const rows = getCompactedSummaries(this.db);
		if (rows.length) parts.push(`## Compacted history\n${rows.map(s => `[${s.role}] ${s.summary}`).join('\n\n')}`);
		return parts.length ? parts.join('\n\n') : undefined;
	}
}
