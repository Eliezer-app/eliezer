import Database from 'better-sqlite3';
import { Tool, ToolResult } from './tools.mts';

interface SearchOptions {
	parts: string[];
	limit?: number;
	context?: number;
	since?: number;
	until?: number;
	role?: 'user' | 'assistant';
}

interface SearchResult {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
	context?: {
		before: Array<{ role: string; content: string }>;
		after: Array<{ role: string; content: string }>;
	};
}

const SNIPPET_LENGTH = 200;
const CONTEXT_SNIPPET_LENGTH = 120;

function buildWhere(column: string, parts: string[], opts: SearchOptions): { sql: string; params: (string | number)[] } {
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since); }
	if (opts.until) { conditions.push('created_at <= ?'); params.push(opts.until); }
	if (opts.role) { conditions.push('role = ?'); params.push(opts.role); }

	for (const p of parts) {
		conditions.push(`${column} LIKE ?`);
		params.push(`%${p}%`);
	}

	return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function searchMemory(db: Database.Database, options: SearchOptions): SearchResult[] {
	const { parts, limit = 10, context = 0 } = options;
	if (!parts.length) return [];

	const results: SearchResult[] = [];

	// Search raw messages
	const msg = buildWhere('content', parts, options);
	const msgRows = db.prepare(
		`SELECT chat_message_id, role, content, created_at, rowid
		 FROM messages ${msg.sql}
		 ORDER BY created_at DESC LIMIT ?`
	).all(...msg.params, limit) as Array<{
		chat_message_id: string; role: string; content: string; created_at: number; rowid: number;
	}>;

	for (const row of msgRows) {
		const result: SearchResult = {
			id: row.chat_message_id,
			role: row.role as 'user' | 'assistant',
			content: extractSnippet(row.content, parts[0]),
			createdAt: row.created_at,
		};
		if (context > 0) result.context = getContext(db, row.rowid, context);
		results.push(result);
	}

	// Search compacted summaries
	const cmp = buildWhere('summary', parts, options);
	const cmpRows = db.prepare(
		`SELECT id, role, summary, created_at
		 FROM compacted ${cmp.sql}
		 ORDER BY created_at DESC LIMIT ?`
	).all(...cmp.params, limit) as Array<{
		id: number; role: string; summary: string; created_at: number;
	}>;

	for (const row of cmpRows) {
		results.push({
			id: `compacted-${row.id}`,
			role: row.role as 'user' | 'assistant',
			content: row.summary.slice(0, SNIPPET_LENGTH),
			createdAt: row.created_at,
		});
	}

	results.sort((a, b) => b.createdAt - a.createdAt);
	return results.slice(0, limit);
}

function extractSnippet(content: string, query: string): string {
	const idx = content.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return content.slice(0, SNIPPET_LENGTH);
	const start = Math.max(0, idx - 80);
	const end = Math.min(content.length, start + SNIPPET_LENGTH);
	const prefix = start > 0 ? '...' : '';
	const suffix = end < content.length ? '...' : '';
	return prefix + content.slice(start, end) + suffix;
}

function getContext(
	db: Database.Database, rowid: number, count: number
): { before: Array<{ role: string; content: string }>; after: Array<{ role: string; content: string }> } {
	const before = db.prepare(
		`SELECT role, content FROM messages WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`
	).all(rowid, count) as Array<{ role: string; content: string }>;

	const after = db.prepare(
		`SELECT role, content FROM messages WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`
	).all(rowid, count) as Array<{ role: string; content: string }>;

	return {
		before: before.reverse().map(r => ({ role: r.role, content: r.content.slice(0, CONTEXT_SNIPPET_LENGTH) })),
		after: after.map(r => ({ role: r.role, content: r.content.slice(0, CONTEXT_SNIPPET_LENGTH) })),
	};
}

function formatResults(results: SearchResult[]): string {
	if (!results.length) return 'No results found.';

	const lines: string[] = [`${results.length} result(s):\n`];
	for (const r of results) {
		const date = new Date(r.createdAt * 1000).toISOString().slice(0, 16);
		const tag = r.id.startsWith('compacted-') ? ' [summary]' : '';
		lines.push(`[${date}] ${r.role}${tag}:`);
		lines.push(r.content);
		if (r.context) {
			if (r.context.before.length) {
				lines.push('  \u2191 before:');
				r.context.before.forEach(c => lines.push(`    ${c.role}: ${c.content.slice(0, 80)}${c.content.length > 80 ? '...' : ''}`));
			}
			if (r.context.after.length) {
				lines.push('  \u2193 after:');
				r.context.after.forEach(c => lines.push(`    ${c.role}: ${c.content.slice(0, 80)}${c.content.length > 80 ? '...' : ''}`));
			}
		}
		lines.push('');
	}
	return lines.join('\n');
}

export function createSearchHistoryTool(db: Database.Database): Tool {
	return {
		name: 'search_message_history',
		description: `Search past conversation history. All parts must match (AND). Searches raw messages and compacted summaries.

Optional: context (N messages before/after), since/until (unix timestamps), role filter.`,
		input_schema: {
			type: 'object',
			properties: {
				parts: { type: 'array', items: { type: 'string' }, description: 'Search terms — all must match (AND)' },
				limit: { type: 'number', description: 'Max results (default: 10)' },
				context: { type: 'number', description: 'Include N messages before/after each match (default: 0)' },
				since: { type: 'number', description: 'Unix timestamp — only messages after this time' },
				until: { type: 'number', description: 'Unix timestamp — only messages before this time' },
				role: { type: 'string', enum: ['user', 'assistant'], description: 'Filter by message role' },
			},
			required: ['parts'],
		},
		async call(input: Record<string, any>): Promise<ToolResult> {
			try {
				const results = searchMemory(db, input as SearchOptions);
				return { content: formatResults(results), isError: false };
			} catch (e: any) {
				return { content: `Search error: ${e.message}`, isError: true };
			}
		},
	};
}
