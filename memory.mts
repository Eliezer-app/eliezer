import Database from 'better-sqlite3';
import { ContentBlock, Message, LLMBase } from './llm.mts';
import { readFileSync } from 'fs';
import { getUncompressedGroups, getCompactedSummaries, compressGroup, compressGroups, estimateTokens } from './compaction.mts';

export interface CompactionConfig {
	tokenBudget: number;
	groupGapSeconds: number;
	flowLimitSeconds: number;
	promptsDir: string;
}

export class Memory {
	private db: Database.Database;
	private contextLimit: number;
	private compaction?: CompactionConfig;

	constructor(db: Database.Database, contextLimit = 100) {
		this.db = db;
		this.contextLimit = contextLimit;
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

	deleteByChatMessageId(chatMessageId: string): number {
		return this.db.prepare('DELETE FROM messages WHERE chat_message_id = ?').run(chatMessageId).changes;
	}

	getContext(): Message[] {
		const rows = this.db.prepare(
			'SELECT role, content FROM messages ORDER BY rowid DESC LIMIT ?'
		).all(this.contextLimit) as Array<{ role: string; content: string }>;

		const messages = rows.reverse().map(r => {
			let content: string | ContentBlock[];
			try {
				const parsed = JSON.parse(r.content);
				content = Array.isArray(parsed) ? parsed : r.content;
			} catch {
				content = r.content;
			}
			return { role: r.role as 'user' | 'assistant', content };
		});

		// Drop leading messages that reference tool_use_ids not in context
		// (happens when context window cuts mid-tool-exchange)
		while (messages.length > 0) {
			const msg = messages[0];
			if (!Array.isArray(msg.content)) break;
			const toolResults = msg.content.filter(b => b.type === 'tool_result') as
				Array<Extract<ContentBlock, { type: 'tool_result' }>>;
			if (!toolResults.length) break;
			// All tool_result ids must have matching tool_use in a prior assistant message
			// Since this is the first message, there's no prior — drop it
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
		return compressGroups(this.db, toCompress, llm, promptsDir);
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
		return compressGroup(this.db, groups[0], llm, promptsDir, priorContext);
	}

	private buildPriorContext(): string | undefined {
		const parts: string[] = [];
		let mem = '';
		try { mem = readFileSync(`${this.compaction!.promptsDir}/memory.md`, 'utf-8').trim(); } catch {}
		if (mem) parts.push(`## Memory\n${mem}`);
		const summaries = getCompactedSummaries(this.db);
		if (summaries.length) parts.push(`## Compacted history\n${summaries.join('\n\n')}`);
		return parts.length ? parts.join('\n\n') : undefined;
	}
}
