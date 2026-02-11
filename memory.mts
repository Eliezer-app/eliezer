import Database from 'better-sqlite3';
import { ContentBlock, Message, LLMBase } from './llm.mts';
import { readFileSync } from 'fs';
import { getUncompressedGroups, getCompactedSummaries, compressGroup, compressGroups, distillToMemory, estimateTokens, formatTimestamp } from './compaction.mts';

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
		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				chat_message_id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER DEFAULT (unixepoch()),
				context_content TEXT,
				archived_at TEXT
			);
		`);
		// Migrate existing tables
		const cols = db.pragma('table_info(messages)') as Array<{ name: string }>;
		const colNames = new Set(cols.map(c => c.name));
		if (!colNames.has('context_content')) db.exec('ALTER TABLE messages ADD COLUMN context_content TEXT');
		if (!colNames.has('archived_at')) db.exec('ALTER TABLE messages ADD COLUMN archived_at TEXT');

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
			'DELETE FROM messages WHERE chat_message_id = ? AND context_content IS NULL'
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
			'SELECT role, content, created_at FROM messages WHERE context_content IS NULL AND archived_at IS NULL ORDER BY rowid'
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
					content = [{ type: 'text', text: `[${ts}]` } as ContentBlock, ...parsed];
				} else {
					content = `[${ts}] ${r.content}`;
				}
			} catch {
				content = `[${ts}] ${r.content}`;
			}
			pushMessage(r.role as 'user' | 'assistant', content);
		}

		// Drop leading messages that reference tool_use_ids not in context
		while (messages.length > 0) {
			const msg = messages[0];
			if (!Array.isArray(msg.content)) break;
			const toolResults = msg.content.filter(b => b.type === 'tool_result') as
				Array<Extract<ContentBlock, { type: 'tool_result' }>>;
			if (!toolResults.length) break;
			messages.shift();
		}

		return messages;
	}

	setCompactionConfig(config: CompactionConfig): void {
		this.compaction = config;
	}

	private tokenUsage(): number {
		const rows = this.db.prepare(
			"SELECT content FROM messages WHERE context_content IS NULL AND archived_at IS NULL"
		).all() as Array<{ content: string }>;
		return rows.reduce((sum, r) => sum + estimateTokens(r.content), 0);
	}

	/** Idle compaction: batch all eligible groups (except current) into one LLM call. */
	async compact(llm: LLMBase): Promise<{ tokensBefore: number; tokensAfter: number } | null> {
		if (!this.compaction) throw new Error('compaction not configured');
		const { tokenBudget, groupGapSeconds, flowLimitSeconds, promptsDir } = this.compaction;

		const tokens = this.tokenUsage();
		if (tokens <= tokenBudget / 3) return null;

		const groups = getUncompressedGroups(this.db, groupGapSeconds);
		if (groups.length < 2) return null;

		const now = Math.floor(Date.now() / 1000);
		const oldest = groups[0];
		const lastMsgTime = oldest.messages[oldest.messages.length - 1].created_at;
		if (now - lastMsgTime < flowLimitSeconds) return null;

		const toCompress = groups.slice(0, -1);
		return compressGroups(this.db, toCompress, llm, promptsDir, this.timezone);
	}

	/** Emergency compaction: compress oldest group only, with full prior context. */
	async compactTail(llm: LLMBase): Promise<{ tokensBefore: number; tokensAfter: number } | null> {
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

		const anchors = this.db.prepare(
			"SELECT rowid, context_content as summary FROM messages WHERE context_content IS NOT NULL AND context_content != '' AND archived_at IS NULL ORDER BY rowid"
		).all() as Array<{ rowid: number; summary: string }>;

		const compactedTokens = anchors.reduce((sum, a) => sum + estimateTokens(a.summary), 0);
		if (compactedTokens <= tokenBudget / 3) return null;

		const half = Math.ceil(anchors.length / 2);
		const toDistill = anchors.slice(0, half);
		const cutoffRowid = toDistill[toDistill.length - 1].rowid;

		await distillToMemory(this.db, llm, `${promptsDir}/memory.md`, toDistill.map(a => a.summary));

		const archived = this.db.prepare(
			"UPDATE messages SET archived_at = datetime('now') WHERE context_content IS NOT NULL AND archived_at IS NULL AND rowid <= ?"
		).run(cutoffRowid).changes;

		this.db.prepare(
			"INSERT INTO compaction_log (op, group_start, group_end, tokens_before, tokens_after) VALUES ('distill', ?, ?, ?, 0)"
		).run(toDistill[0].rowid, cutoffRowid, compactedTokens);

		return { distilled: toDistill.length, archived };
	}

	private buildPriorContext(): string | undefined {
		const parts: string[] = [];
		let mem = '';
		try { mem = readFileSync(`${this.compaction!.promptsDir}/memory.md`, 'utf-8').trim(); } catch {}
		if (mem) parts.push(`## Memory\n${mem}`);
		const summaries = getCompactedSummaries(this.db);
		if (summaries.length) parts.push(`## Compacted history\n${summaries.map(s => `[${s.role}] ${s.summary}`).join('\n\n')}`);
		return parts.length ? parts.join('\n\n') : undefined;
	}
}
