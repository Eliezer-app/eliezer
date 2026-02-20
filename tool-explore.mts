import { readFileSync } from 'fs';
import { LLMBase } from './llm.mts';
import { ToolBase, ToolResult } from './tools.mts';
import { AgentToolBase } from './agent-tool.mts';
import { FileSearchTool } from './tool-file-search.mts';

function numberLines(text: string, offset: number): string {
	return text.split('\n').map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

class AgentReadTool extends ToolBase {
	name = 'read';
	description = 'Read a file. Returns numbered lines. Use offset/limit for large files.';
	input_schema = {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path' },
			offset: { type: 'number', description: 'Start line (1-based, default: 1)' },
			limit: { type: 'number', description: 'Max lines to return (default: all)' },
		},
		required: ['path'],
	};

	async call({ path, offset, limit }: Record<string, any>): Promise<ToolResult> {
		try {
			const content = readFileSync(path, 'utf-8');
			const lines = content.split('\n');
			const start = Math.max(0, (offset ?? 1) - 1);
			const end = limit ? start + limit : lines.length;
			const slice = lines.slice(start, end);
			const result = numberLines(slice.join('\n'), start);
			const total = lines.length;
			const header = `[${path}: ${total} lines, showing ${start + 1}-${Math.min(end, total)}]`;
			return { content: `${header}\n${result}`, isError: false };
		} catch (e: any) {
			return { content: e.message, isError: true };
		}
	}
}

export class CodebaseExplorerTool extends AgentToolBase {
	name = 'explore';
	defaultTimeout = 600;
	description = 'Explore a codebase. Provide a path and a question. Be specific about the aspect you are interested in, if any. The explorer can operate in two modes: brief (default — overview, key files, structure) and detailed (ask for "details" — exhaustive file paths, line numbers, function signatures, call chains). Examples: "how does auth work?", "what breaks if I rename X?", "why is test Y failing?", "what are the dependencies of module Z?". Use this to keep your context small.';
	input_schema = {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Root directory of the codebase' },
			question: { type: 'string', description: 'What to find or understand' },
		},
		required: ['path', 'question'],
	};

	protected systemPrompt = `You are an expert code explorer. Your audience is an AI software engineer who will edit code based on your answer.

Keep the number of tool calls low — read broadly, then answer. Do not explore one file at a time.

If asked for a brief exploration (or no mode specified): provide an overview — key files, directory structure, patterns, tech stack.

If asked for details: be exhaustive. Provide relevant key constructs: layers, patterns, files, classes, functions with line numbers. Your output replaces the caller reading those files — nothing you omit can be recovered without another exploration.

Example detailed output format:

## Authentication Flow

src/routes/auth.ts
- POST /login (line 24): validates credentials via AuthService.verify()
- POST /register (line 58): creates user, sends verification email
- GET /oauth/google (line 91): Passport Google strategy redirect

src/services/AuthService.ts
- class AuthService (line 12)
  - verify(email, password) (line 34): bcrypt compare, returns User | null
  - createSession(userId) (line 67): inserts into sessions table, returns token
  - revokeSession(token) (line 89): deletes from sessions table

src/middleware/requireAuth.ts
- requireAuth() (line 8): reads token from cookie, calls AuthService.validateSession()
- requireAdmin() (line 22): extends requireAuth, checks user.role === 'admin'

Call chain: POST /login → AuthService.verify() → AuthService.createSession() → set cookie
`;
	protected agentTools: ToolBase[];

	constructor(llm: LLMBase) {
		super(llm);
		this.agentTools = [new AgentReadTool(), new FileSearchTool()];
	}

	protected buildTask(input: Record<string, any>): string {
		return `Codebase root: ${input.path}\n\nQuestion: ${input.question}`;
	}
}
