import { exec } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ToolBase, ToolResult } from './tools.mts';

const ALLOWED_COMMANDS = new Set(['ls', 'grep', 'find', 'df', 'wc', 'tree']);
const TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 20_000;

const TREE_ENTRIES_PER_DIR = 50;
const TREE_MAX_LINES = 500;
const TREE_SKIP = new Set(['node_modules', '.git', '.pnpm-store', '.cache', '__pycache__', '.venv', 'dist', 'build', 'coverage']);

function buildTree(root: string, extraSkip?: string[]): string {
	const skip = extraSkip?.length ? new Set([...TREE_SKIP, ...extraSkip]) : TREE_SKIP;
	const lines: string[] = [];
	let exhausted = false;

	function emit(line: string): boolean {
		if (exhausted) return false;
		lines.push(line);
		if (lines.length >= TREE_MAX_LINES) {
			exhausted = true;
			lines.push('... (tree truncated)');
			return false;
		}
		return true;
	}

	function walk(dir: string, prefix: string) {
		if (exhausted) return;
		let entries: Array<{ name: string; isDir: boolean }>;
		try {
			entries = readdirSync(dir).map(name => {
				try { return { name, isDir: statSync(join(dir, name)).isDirectory() }; }
				catch { return { name, isDir: false }; }
			});
		} catch { return; }

		const skipped = entries.filter(e => e.isDir && skip.has(e.name));
		entries = entries.filter(e => !e.isDir || !skip.has(e.name));
		for (const s of skipped) emit(`${prefix}${s.name}/  (excluded)`);
		entries.sort((a, b) => {
			if (a.isDir !== b.isDir) return a.isDir ? 1 : -1; // files first
			return a.name.localeCompare(b.name);
		});

		const shown = entries.slice(0, TREE_ENTRIES_PER_DIR);
		const remaining = entries.length - shown.length;

		for (const e of shown) {
			if (exhausted) return;
			if (e.isDir) {
				if (!emit(`${prefix}${e.name}/`)) return;
				walk(join(dir, e.name), prefix + '  ');
			} else {
				if (!emit(`${prefix}${e.name}`)) return;
			}
		}
		if (remaining > 0) {
			emit(`${prefix}... +${remaining} more`);
		}
	}

	emit(root);
	walk(root, '  ');
	return lines.join('\n');
}

function truncate(output: string): string {
	if (output.length <= MAX_OUTPUT) return output;
	const half = Math.floor(MAX_OUTPUT / 2) - 50;
	const cut = output.length - MAX_OUTPUT;
	return `${output.slice(0, half)}\n\n... (${cut} chars truncated) ...\n\n${output.slice(-half)}`;
}

export class FileSearchTool extends ToolBase {
	name = 'file_search';
	description = 'Search files. command: ls, grep, find, df, wc, tree. path = working directory for all commands. tree shows project structure (auto-excludes: node_modules, .git, .pnpm-store, dist, build, coverage, .cache, __pycache__, .venv; args = additional dirs to exclude). Others take standard args. 5s timeout, output capped.';
	input_schema = {
		type: 'object',
		properties: {
			command: { type: 'string', enum: ['ls', 'grep', 'find', 'df', 'wc', 'tree'], description: 'Command to run' },
			args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (for tree: extra dirs to exclude)' },
			path: { type: 'string', description: 'Working directory (default: cwd)' },
		},
		required: ['command'],
	};

	async call({ command, args, path }: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
		if (!ALLOWED_COMMANDS.has(command)) {
			return { content: `Unknown command: ${command}. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`, isError: true };
		}

		if (command === 'tree') {
			const root = path || process.cwd();
			try {
				return { content: buildTree(root, args), isError: false };
			} catch (e: any) {
				return { content: e.message, isError: true };
			}
		}

		const cwd = path || process.cwd();
		try {
			if (!statSync(cwd).isDirectory()) return { content: `Not a directory: ${cwd}`, isError: true };
		} catch (e: any) {
			return { content: `Invalid path: ${cwd}: ${e.message}`, isError: true };
		}

		const shellArgs = (args || []).map((a: string) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
		const cmd = `${command} ${shellArgs}`;

		return new Promise(resolve => {
			const child = exec(cmd, { encoding: 'utf-8', timeout: TIMEOUT_MS, cwd }, (err, stdout, stderr) => {
				if (signal?.aborted) resolve({ content: 'aborted', isError: true });
				else if (err && !stdout) resolve({ content: truncate(err.message), isError: true });
				else resolve({ content: truncate(stdout || stderr), isError: false });
			});
			signal?.addEventListener('abort', () => child.kill(), { once: true });
		});
	}
}
