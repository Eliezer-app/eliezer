import { ContentBlock, LLMBase, Message } from './llm.mts';
import { Logger } from './log.mts';
import { ToolBase, ToolResult } from './tools.mts';

const MAX_TURNS = 100;
const TOOL_OUTPUT_MAX_CHARS = 20_000;

export abstract class AgentToolBase extends ToolBase {
	protected abstract systemPrompt: string;
	protected abstract agentTools: ToolBase[];
	protected llm: LLMBase;
	private _log?: Logger;
	protected get log(): Logger {
		return this._log ??= new Logger({ module: `SubAgent:${this.name}` });
	}

	constructor(llm: LLMBase) {
		super();
		this.llm = llm;
	}

	async call(input: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
		const task = this.buildTask(input);
		const tools = this.agentTools;
		const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
		const messages: Message[] = [{ role: 'user', content: task }];

		for (let turn = 0; turn < MAX_TURNS; turn++) {
			if (signal?.aborted) return { content: 'aborted', isError: true };

			const response = await this.llm.call(messages, this.systemPrompt, toolDefs, signal);
			// Keep reasoning blocks — some providers (e.g. Kimi) require them on history replay
			const content = response.content.filter(b => b.type === 'text' || b.type === 'tool_use' || b.type === 'reasoning');
			const toolUses = content.filter(b => b.type === 'tool_use') as
				Array<Extract<ContentBlock, { type: 'tool_use' }>>;

			if (!toolUses.length) {
				const text = content
					.filter(b => b.type === 'text')
					.map(b => (b as Extract<ContentBlock, { type: 'text' }>).text)
					.join('\n');
				return { content: text || '(no response)', isError: false };
			}

			messages.push({ role: 'assistant', content });

			const results: ContentBlock[] = [];
			for (const tu of toolUses) {
				if (signal?.aborted) return { content: 'aborted', isError: true };
				const tool = tools.find(t => t.name === tu.name);
				if (!tool) {
					results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}` });
					continue;
				}
				this.log.info(`tool:${tu.name}`);
				this.log.debug(`tool:${tu.name}`, { input: JSON.stringify(tu.input) });
				let { content: result, isError } = await tool.call(tu.input, signal);
				this.log[isError ? 'error' : 'info'](`tool:${tu.name}`, { result: isError ? 'error' : 'ok' });
				if (result.length > TOOL_OUTPUT_MAX_CHARS) {
					result = result.slice(0, TOOL_OUTPUT_MAX_CHARS) + '\n... (truncated)';
				}
				results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
			}
			messages.push({ role: 'user', content: results });
		}

		return { content: 'Max turns reached', isError: true };
	}

	protected abstract buildTask(input: Record<string, any>): string;
}
