export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
	| { type: 'tool_result'; tool_use_id: string; content: string };

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

	constructor(tokenLimit = 500_000) {
		this.tokenLimit = tokenLimit;
	}

	hasBudget(): boolean { return this.tokensUsed < this.tokenLimit; }

	protected addTokens(input: number, output: number) {
		this.tokensUsed += input + output;
	}

	abstract call(messages: Message[], system: string, tools?: ToolDef[]): Promise<LLMResponse>;
}

export class AnthropicLLM extends LLMBase {
	private apiKey: string;
	private model: string;
	private baseUrl: string;

	constructor(opts: { apiKey: string; model: string; baseUrl?: string; tokenLimit?: number }) {
		super(opts.tokenLimit);
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
	}

	async call(messages: Message[], system: string, tools: ToolDef[] = []): Promise<LLMResponse> {
		const body: any = {
			model: this.model,
			max_tokens: 4096,
			system,
			messages,
		};
		if (tools.length) body.tools = tools;

		const res = await fetch(`${this.baseUrl}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		});

		const data = await res.json() as any;
		if (data.error) throw new Error(data.error.message);
		this.addTokens(data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
		return { content: data.content ?? [], stop_reason: data.stop_reason };
	}
}

export class OpenAILLM extends LLMBase {
	private apiKey: string;
	private model: string;
	private baseUrl: string;

	constructor(opts: { apiKey: string; model: string; baseUrl: string; tokenLimit?: number }) {
		super(opts.tokenLimit);
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.baseUrl = opts.baseUrl.replace(/\/$/, '');
	}

	async call(messages: Message[], system: string, tools: ToolDef[] = []): Promise<LLMResponse> {
		const body: any = {
			model: this.model,
			messages: this.messagesToOpenAI(messages, system),
		};
		if (tools.length) {
			body.tools = tools.map(t => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.input_schema },
			}));
		}

		const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify(body),
		});

		const data = await res.json() as any;
		if (data.error) throw new Error(data.error.message);
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
				const oai: any = { role: 'assistant' };
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
