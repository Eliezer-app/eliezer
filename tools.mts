import { exec, execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream, mkdtempSync, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolDef, LLMBase } from './llm.mts';
import { CronManager } from './cron.mts';
import { SearchProvider, fenceResults } from './search.mts';
import { vetContent } from './vetting.mts';
import exifr from 'exifr';

const VETTABLE_TYPES = [
	'text/',              // text/html, text/plain, text/css, text/csv, text/xml, text/markdown, etc.
	'application/json',
	'application/xml',
	'application/javascript',
	'image/svg+xml',
];

const IMAGE_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
];

const PASSTHROUGH_TYPES = [
	'audio/mpeg',         // mp3
	'video/mp4',
	'audio/mp4',
];

const PASSTHROUGH_EXTENSIONS = [
	'.db',                // SQLite
	'.sqlite',
	'.sqlite3',
];

const MAX_SIZE_AUTOVET = 10_000_000; // 10MB — text files under this are auto-vetted (sampled first+last 25k chars)

export interface ToolResult {
	content: string;
	isError: boolean;
	signal?: 'restart';
	skipSecretRedaction?: boolean;
}

export interface Tool extends ToolDef {
	call(input: Record<string, any>, signal?: AbortSignal): Promise<ToolResult>;
}

function safe(fn: () => string): ToolResult {
	try { return { content: fn(), isError: false }; }
	catch (e: any) { return { content: e.message, isError: true }; }
}

function numberLines(text: string, offset: number): string {
	return text.split('\n').map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

export function createTools(vettingLlm?: LLMBase): Tool[] {
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
			call: async ({ command }, signal) => {
				if (/\|\s*(sudo\s+)?(ba|da|z|fi)?sh\b/.test(command)) {
					return { content: 'Piping into a shell is not allowed. Download files with wget_tool and run them separately.', isError: true };
				}
				if (/\b(curl|wget)\b/.test(command)) {
					return { content: 'curl/wget are not allowed. Use wget_tool instead — it\'s vetted by the security gate.', isError: true };
				}
				return new Promise(resolve => {
					const child = exec(command, { encoding: 'utf-8', timeout: 30_000 }, (err, stdout, stderr) => {
						if (signal?.aborted) resolve({ content: 'aborted', isError: true });
						else if (err) resolve({ content: err.message, isError: true });
						else resolve({ content: stdout || stderr, isError: false });
					});
					signal?.addEventListener('abort', () => child.kill(), { once: true });
				});
			},
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
			call: async ({ path, content }) => safe(() => { mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(path, content); readFiles.add(path); return 'ok'; }),
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
			name: 'wget_tool',
			description: 'Download a file from a URL to a temp path. Returns the path. curl/wget are not available — use this tool instead, downloads are security-vetted. For apps/widgets, move files to /opt/clawchat/apps/<my-app>/file. For public (user visible) media files, use /opt/eliezer/chat-public/.',
			input_schema: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'URL to download' },
				},
				required: ['url'],
			},
			call: async ({ url }, signal) => {
				const MAX_SIZE = 100 * 1024 * 1024; // 100MB
				try {
					const signals = [AbortSignal.timeout(60_000)];
					if (signal) signals.push(signal);
					// HEAD request to check content-type and size before downloading
					const head = await fetch(url, {
						method: 'HEAD',
						redirect: 'follow',
						signal: AbortSignal.any(signals),
					});
					if (!head.ok) return { content: `HTTP ${head.status} ${head.statusText}`, isError: true };
					const ct = head.headers.get('content-type') || '';
					const ext = new URL(url).pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() || '';
					const isVettable = VETTABLE_TYPES.some(t => ct.includes(t));
					const isImage = IMAGE_TYPES.some(t => ct.includes(t));
					const isPassthrough = PASSTHROUGH_TYPES.some(t => ct.includes(t)) || PASSTHROUGH_EXTENSIONS.includes(ext);
					if (!isVettable && !isImage && !isPassthrough) {
						return { content: `[BLOCKED] Content-Type "${ct}" is not supported.`, isError: true };
					}
					const cl = head.headers.get('content-length');
					if (cl && parseInt(cl) > MAX_SIZE) {
						return { content: `[BLOCKED] File too large (${Math.round(parseInt(cl) / 1024 / 1024)}MB). Limit: 100MB.`, isError: true };
					}
					const res = await fetch(url, {
						redirect: 'follow',
						signal: AbortSignal.any(signals),
					});
					if (!res.ok) return { content: `HTTP ${res.status} ${res.statusText}`, isError: true };
					if (!res.body) return { content: 'No response body', isError: true };
					const dir = mkdtempSync(join(tmpdir(), 'dl-'));
					const filename = new URL(url).pathname.split('/').pop() || 'download';
					const path = join(dir, filename);
					await pipeline(res.body as any, createWriteStream(path));
					const size = statSync(path).size;
					if (size > MAX_SIZE) {
						execSync(`rm -rf ${JSON.stringify(dir)}`);
						return { content: `[BLOCKED] File too large (${Math.round(size / 1024 / 1024)}MB). Limit: 100MB.`, isError: true };
					}
					// Passthrough: no vetting
					if (isPassthrough) {
						return { content: `Downloaded ${size} bytes to ${path}`, isError: false };
					}
					// Images: extract metadata and vet it
					if (isImage) {
						if (vettingLlm) {
							let metadata: string;
							try {
								const parsed = await exifr.parse(path, true);
								metadata = parsed ? JSON.stringify(parsed, null, 2) : '';
							} catch {
								metadata = '';
							}
							if (metadata) {
								let result: { safe: boolean; reason?: string };
								try {
									result = await vetContent(vettingLlm, metadata, `image metadata: ${url}`);
								} catch (e: any) {
									execSync(`rm -rf ${JSON.stringify(dir)}`);
									return { content: `[BLOCKED] Vetting failed: ${e.message}`, isError: true };
								}
								if (!result.safe) {
									execSync(`rm -rf ${JSON.stringify(dir)}`);
									return { content: `[BLOCKED] Image metadata failed security vetting: ${result.reason}`, isError: true };
								}
							}
						}
						return { content: `Downloaded ${size} bytes to ${path}`, isError: false };
					}
					// Text: verify content and vet
						const raw = readFileSync(path);
					const isText = !raw.some(b => b === 0) && raw.filter(b => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d).length / raw.length < 0.05;
					if (!isText) {
						execSync(`rm -rf ${JSON.stringify(dir)}`);
						return { content: `[BLOCKED] File content is binary despite text Content-Type.`, isError: true };
					}
					const text = raw.toString('utf-8');
					if (vettingLlm && size <= MAX_SIZE_AUTOVET) {
						let result: { safe: boolean; reason?: string };
						try {
							result = await vetContent(vettingLlm, text, `downloaded file: ${url}`);
						} catch (e: any) {
							execSync(`rm -rf ${JSON.stringify(dir)}`);
							return { content: `[BLOCKED] Vetting failed: ${e.message}`, isError: true };
						}
						if (!result.safe) {
							execSync(`rm -rf ${JSON.stringify(dir)}`);
							return { content: `[BLOCKED] Downloaded file failed security vetting: ${result.reason}`, isError: true };
						}
					}
					return { content: `Downloaded ${size} bytes to ${path}`, isError: false };
				} catch (e: any) {
					return { content: e.message, isError: true };
				}
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

const UNIT_SECONDS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

export function parseDuration(s: string, defaultSec: number): number;
export function parseDuration(s: string): number | null;
export function parseDuration(s: string, defaultSec?: number): number | null {
	// Compound: "1h30m", "1m:30s", "2h:15m:30s"
	const parts = s.replace(/:/g, '').match(/\d+\s*[smhd]/g);
	if (parts) {
		let total = 0;
		for (const p of parts) {
			const m = p.match(/^(\d+)\s*([smhd])$/);
			if (!m) return defaultSec ?? null;
			total += parseInt(m[1]) * UNIT_SECONDS[m[2]];
		}
		return total || (defaultSec ?? null);
	}
	// Bare number (seconds)
	const bare = s.match(/^(\d+)$/);
	if (bare) return parseInt(bare[1]) || (defaultSec ?? null);
	return defaultSec ?? null;
}

export function createScheduleTool(cronManager: CronManager): Tool {
	return {
		name: 'schedule',
		description: 'Schedule prompts. Provide cron for recurring or delay for one-shot (e.g. "10m", "2h"). No action field = create/update (prompt required + cron or delay; same name overwrites). Actions: pause, resume, delete. One-shots auto-delete after firing.',
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Unique name for the schedule' },
				prompt: { type: 'string', description: 'Prompt sent to you when it fires (required for create)' },
				cron: { type: 'string', description: 'Cron expression for recurring, e.g. "*/5 * * * *"' },
				delay: { type: 'string', description: 'One-shot delay, e.g. "10m", "2h", "1d"' },
				action: { type: 'string', enum: ['pause', 'resume', 'delete'], description: 'Control action (omit to create)' },
			},
			required: ['name'],
		},
		async call(input): Promise<ToolResult> {
			try {
				if (!input.action) {
					if (!input.prompt) return { content: 'Error: prompt is required to create a schedule', isError: true };
					if (input.delay) {
						if (!/[smhd]/.test(input.delay)) return { content: `Invalid delay format: "${input.delay}". Must include a unit (s, m, h, d). E.g. "10m", "2h", "1h30m"`, isError: true };
						const sec = parseDuration(input.delay);
						if (!sec) return { content: `Invalid delay format: "${input.delay}". Use e.g. "10m", "2h", "1d", "1h30m"`, isError: true };
						cronManager.createOneShot(input.name, input.prompt, sec);
						return { content: `Scheduled "${input.name}" to run in ${input.delay}`, isError: false };
					}
					if (!input.cron) return { content: 'Error: cron or delay is required to create a schedule', isError: true };
					cronManager.create(input.name, input.prompt, input.cron);
					return { content: `Scheduled "${input.name}" with cron ${input.cron}`, isError: false };
				}
				let ok: boolean;
				switch (input.action) {
					case 'pause': ok = cronManager.pause(input.name); break;
					case 'resume': ok = cronManager.resume(input.name); break;
					case 'delete': ok = cronManager.delete(input.name); break;
					default: return { content: `Unknown action: ${input.action}`, isError: true };
				}
				if (!ok) return { content: `Schedule "${input.name}" not found`, isError: true };
				return { content: `${input.action}d "${input.name}"`, isError: false };
			} catch (e: any) {
				return { content: e.message, isError: true };
			}
		},
	};
}

export function createWebSearchTool(provider: SearchProvider, vettingLlm?: LLMBase): Tool {
	return {
		name: 'web_search',
		description: 'Search the web. Returns titles, URLs, and snippets. Use wget_tool to download full pages when needed.',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				limit: { type: 'number', description: 'Max results (default: 5)' },
			},
			required: ['query'],
		},
		async call({ query, limit }): Promise<ToolResult> {
			try {
				const results = await provider.search(query, { limit: limit ?? 5 });
				if (!results.length) return { content: `No results for "${query}"`, isError: false };

				if (vettingLlm) {
					const raw = results.map(r => `${r.title}\n${r.snippet}`).join('\n\n');
					const vet = await vetContent(vettingLlm, raw, `web search: ${query}`);
					if (!vet.safe) return { content: `[BLOCKED: ${vet.reason}]`, isError: false };
				}

				return { content: fenceResults(results), isError: false };
			} catch (e: any) {
				return { content: e.message, isError: true };
			}
		},
	};
}

