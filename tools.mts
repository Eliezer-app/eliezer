import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { ToolDef } from './llm.mts';

export interface ToolResult {
	content: string;
	isError: boolean;
	signal?: 'restart';
}

export interface Tool extends ToolDef {
	call(input: Record<string, any>): Promise<ToolResult>;
}

function safe(fn: () => string): ToolResult {
	try { return { content: fn(), isError: false }; }
	catch (e: any) { return { content: e.message, isError: true }; }
}

function numberLines(text: string, offset: number): string {
	return text.split('\n').map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

export function createTools(): Tool[] {
	const readFiles = new Set<string>();

	return [
		{
			name: 'exec',
			description: 'Run a shell command and return the output',
			input_schema: {
				type: 'object',
				properties: { command: { type: 'string', description: 'The shell command to execute' } },
				required: ['command'],
			},
			call: async ({ command }) => safe(() => execSync(command, { encoding: 'utf-8', timeout: 30_000 })),
		},
		{
			name: 'read',
			description: 'Read a file. Returns numbered lines for reference only (cat -n). Use offset/limit for large files.',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path' },
					offset: { type: 'number', description: 'Start line (1-based, default: 1)' },
					limit: { type: 'number', description: 'Max lines to return (default: all)' },
				},
				required: ['path'],
			},
			call: async ({ path, offset, limit }) => safe(() => {
				const content = readFileSync(path, 'utf-8');
				const lines = content.split('\n');
				const start = Math.max(0, (offset ?? 1) - 1);
				const end = limit ? start + limit : lines.length;
				const slice = lines.slice(start, end);
				readFiles.add(path);
				const result = numberLines(slice.join('\n'), start);
				const total = lines.length;
				const header = `[${path}: ${total} lines, showing ${start + 1}-${Math.min(end, total)}]`;
				return `${header}\n${result}`;
			}),
		},
		{
			name: 'write',
			description: 'Write content to a file (creates or overwrites)',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path' },
					content: { type: 'string', description: 'File content' },
				},
				required: ['path', 'content'],
			},
			call: async ({ path, content }) => safe(() => { writeFileSync(path, content); readFiles.add(path); return 'ok'; }),
		},
		{
			name: 'edit',
			description: 'Edit a file by replacing a unique string. You must read the file first. Match against raw file content (not the line numbers from read output).',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path' },
					old_string: { type: 'string', description: 'Exact string to find (must be unique in the file)' },
					new_string: { type: 'string', description: 'Replacement string' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
			call: async ({ path, old_string, new_string }) => {
				if (!readFiles.has(path)) {
					return { content: `Error: must read ${path} before editing`, isError: true };
				}
				return safe(() => {
					const content = readFileSync(path, 'utf-8');
					const count = content.split(old_string).length - 1;
					if (count === 0) return `Error: old_string not found in ${path}`;
					if (count > 1) return `Error: old_string matches ${count} times in ${path}. Provide more context to make it unique.`;
					writeFileSync(path, content.replace(old_string, new_string));
					return 'ok';
				});
			},
		},
		{
			name: 'restart_self',
			description: 'Restart the agent process (use after self-modifying code)',
			input_schema: { type: 'object', properties: {} },
			call: async () => ({ content: 'restarting', isError: false, signal: 'restart' as const }),
		},
	];
}

export function createSearchHistoryTool(db: Database.Database): Tool {
	return {
		name: 'search_history',
		description: 'Search past conversation history. Finds messages matching a query across all messages, including those compacted out of context.',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search term (matched against raw message content)' },
				limit: { type: 'number', description: 'Max results (default: 10)' },
			},
			required: ['query'],
		},
		async call({ query, limit }): Promise<ToolResult> {
			const maxResults = limit ?? 10;
			const rows = db.prepare(
				`SELECT role, content, context_content, created_at FROM messages
				 WHERE content LIKE ? OR context_content LIKE ?
				 ORDER BY rowid DESC LIMIT ?`
			).all(`%${query}%`, `%${query}%`, maxResults) as Array<{
				role: string; content: string; context_content: string | null; created_at: number;
			}>;

			if (!rows.length) return { content: `No messages matching "${query}"`, isError: false };

			const results = rows.map(r => {
				const ts = new Date(r.created_at * 1000).toISOString().slice(0, 16);
				const snippet = extractSnippet(r.content, query, 200);
				const summary = r.context_content && r.context_content !== '' ? `\n  Summary: ${r.context_content.slice(0, 200)}` : '';
				return `[${ts}] ${r.role}: ${snippet}${summary}`;
			}).join('\n\n');

			return { content: `${rows.length} result(s):\n\n${results}`, isError: false };
		},
	};
}

function extractSnippet(content: string, query: string, maxLen: number): string {
	const idx = content.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return content.slice(0, maxLen);
	const start = Math.max(0, idx - 80);
	const end = Math.min(content.length, idx + query.length + 80);
	const prefix = start > 0 ? '...' : '';
	const suffix = end < content.length ? '...' : '';
	return prefix + content.slice(start, end) + suffix;
}
