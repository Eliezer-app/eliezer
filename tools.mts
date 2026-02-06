import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
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

export function createTools(): Tool[] {
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
			name: 'write',
			description: 'Write content to a file',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path' },
					content: { type: 'string', description: 'File content' },
				},
				required: ['path', 'content'],
			},
			call: async ({ path, content }) => safe(() => { writeFileSync(path, content); return 'ok'; }),
		},
		{
			name: 'read',
			description: 'Read the contents of a file',
			input_schema: {
				type: 'object',
				properties: { path: { type: 'string', description: 'File path' } },
				required: ['path'],
			},
			call: async ({ path }) => safe(() => readFileSync(path, 'utf-8')),
		},
		{
			name: 'restart_self',
			description: 'Restart the agent process (use after self-modifying code)',
			input_schema: { type: 'object', properties: {} },
			call: async () => ({ content: 'restarting', isError: false, signal: 'restart' as const }),
		},
	];
}
