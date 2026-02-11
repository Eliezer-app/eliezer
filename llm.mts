export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
	| { type: 'tool_result'; tool_use_id: string; content: string }
	| { type: 'reasoning'; content: string };

export interface Message {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

export interface ToolDef {
	name: string;
	description: string;
	input_schema: Record<string, any>;
}

export interface LLMResponse {
	content: ContentBlock[];
	stop_reason: string;
}

export abstract class LLMBase {
	tokensUsed = 0;
	tokenLimit: number;
	protected timeoutMs: number;
	protected maxTokens: number;

	constructor(tokenLimit = 500_000, timeoutMs = 240_000, maxTokens = 4096) {
		this.tokenLimit = tokenLimit;
		this.timeoutMs = timeoutMs;
		this.maxTokens = maxTokens;
	}

	hasBudget(): boolean { return this.tokensUsed < this.tokenLimit; }

	protected addTokens(input: number, output: number) {
		this.tokensUsed += input + output;
	}

	abstract call(messages: Message[], system: string, tools?: ToolDef[], signal?: AbortSignal, jsonMode?: boolean): Promise<LLMResponse>;
}

export function createLLM(opts: { provider: string; apiKey: string; model: string; baseUrl: string; tokenLimit?: number; timeoutMs?: number; maxTokens?: number }): LLMBase {
	return opts.provider === 'anthropic'
		? new AnthropicLLM(opts)
		: new OpenAILLM(opts);
}

export class AnthropicLLM extends LLMBase {
	private apiKey: string;
	private model: string;
	private baseUrl: string;

	constructor(opts: { apiKey: string; model: string; baseUrl?: string; tokenLimit?: number; timeoutMs?: number; maxTokens?: number }) {
		super(opts.tokenLimit, opts.timeoutMs, opts.maxTokens);
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
	}

	async call(messages: Message[], system: string, tools: ToolDef[] = [], signal?: AbortSignal, _jsonMode?: boolean): Promise<LLMResponse> {
		const body: any = {
			model: this.model,
			max_tokens: this.maxTokens,
			system,
			messages,
		};
		if (tools.length) body.tools = tools;

		const url = `${this.baseUrl}/v1/messages`;
		let res: Response;
		const signals = [AbortSignal.timeout(this.timeoutMs)];
		if (signal) signals.push(signal);
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': this.apiKey,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify(body),
				signal: AbortSignal.any(signals),
			});
		} catch (e: any) {
			if (e.name === 'TimeoutError') throw new Error(`LLM timeout after ${this.timeoutMs / 1000}s: ${url}`);
			throw new Error(`LLM unreachable at ${url}: ${e.message}`);
		}

		const data = await res.json() as any;
		if (!res.ok || data.error) throw new Error(`LLM error (${res.status}): ${data.error?.message ?? JSON.stringify(data)}`);
		this.addTokens(data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
		return { content: data.content ?? [], stop_reason: data.stop_reason };
	}
}

export class OpenAILLM extends LLMBase {
	private apiKey: string;
	private model: string;
	private baseUrl: string;

	constructor(opts: { apiKey: string; model: string; baseUrl: string; tokenLimit?: number; timeoutMs?: number; maxTokens?: number }) {
		super(opts.tokenLimit, opts.timeoutMs, opts.maxTokens);
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.baseUrl = opts.baseUrl.replace(/\/$/, '');
	}

	async call(messages: Message[], system: string, tools: ToolDef[] = [], signal?: AbortSignal, jsonMode?: boolean): Promise<LLMResponse> {
		const body: any = {
			model: this.model,
			messages: this.messagesToOpenAI(messages, system),
		};
		if (jsonMode) body.response_format = { type: 'json_object' };
		if (tools.length) {
			body.tools = tools.map(t => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.input_schema },
			}));
		}

		const url = `${this.baseUrl}/v1/chat/completions`;
		let res: Response;
		const signals = [AbortSignal.timeout(this.timeoutMs)];
		if (signal) signals.push(signal);
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
				body: JSON.stringify(body),
				signal: AbortSignal.any(signals),
			});
		} catch (e: any) {
			if (e.name === 'TimeoutError') throw new Error(`LLM timeout after ${this.timeoutMs / 1000}s: ${url}`);
			throw new Error(`LLM unreachable at ${url}: ${e.message}`);
		}

		const data = await res.json() as any;
		if (!res.ok || data.error) throw new Error(`LLM error (${res.status}): ${data.error?.message ?? JSON.stringify(data)}`);
		this.addTokens(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0);
		return this.responseFromOpenAI(data.choices[0]);
	}

	private messagesToOpenAI(messages: Message[], system: string): any[] {
		const out: any[] = [{ role: 'system', content: system }];

		for (const msg of messages) {
			if (typeof msg.content === 'string') {
				out.push({ role: msg.role, content: msg.content });
				continue;
			}

			if (msg.role === 'user') {
				for (const block of msg.content) {
					if (block.type === 'tool_result')
						out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
					else if (block.type === 'text')
						out.push({ role: 'user', content: block.text });
				}
			} else {
				const texts = msg.content.filter(b => b.type === 'text').map(b => (b as any).text);
				const calls = msg.content.filter(b => b.type === 'tool_use').map(b => {
					const tu = b as Extract<ContentBlock, { type: 'tool_use' }>;
					return { id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input) } };
				});
				const reasoning = msg.content.filter(b => b.type === 'reasoning').map(b => (b as any).content).join('');
				const oai: any = { role: 'assistant' };
				if (reasoning) oai.reasoning_content = reasoning;
				if (texts.length) oai.content = texts.join('\n');
				if (calls.length) oai.tool_calls = calls;
				out.push(oai);
			}
		}

		return out;
	}

	private responseFromOpenAI(choice: any): LLMResponse {
		const content: ContentBlock[] = [];
		const msg = choice.message;
		if (msg.reasoning_content) content.push({ type: 'reasoning', content: msg.reasoning_content });
		if (msg.content) content.push({ type: 'text', text: msg.content });
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				content.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.function.name,
					input: JSON.parse(tc.function.arguments),
				});
			}
		}
		return {
			content,
			stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
		};
	}
}
