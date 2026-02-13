import { Tool, ToolResult } from './tools.mts';

export class ChatClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	async send(conversationId: string, content: string, type?: string): Promise<any> {
		return this.request('POST', '/send', { conversationId, content, ...(type ? { type } : {}) });
	}

	async updateMessage(messageId: string, content: string): Promise<any> {
		return this.request('PATCH', `/messages/${messageId}`, { content });
	}

	async deleteMessage(messageId: string): Promise<any> {
		return this.request('DELETE', `/messages/${messageId}`);
	}

	async stateChange(state: string): Promise<any> {
		return this.request('POST', '/agent/state-change', { state });
	}

	private async request(method: string, path: string, body?: unknown): Promise<any> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!res.ok) throw new Error(`Chat API ${method} ${path}: ${res.status}`);
		return res.json();
	}
}

export function createChatTool(client: ChatClient): Tool {
	return {
		name: 'chat',
		description: 'Manage chat messages. Actions: update (edit a sent message), delete (remove a message). A send action also exists but is rarely needed — your plain text responses are automatically delivered to chat.',
		input_schema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['send', 'update', 'delete'] },
				conversationId: { type: 'string', description: 'Required for send' },
				messageId: { type: 'string', description: 'Required for update/delete' },
				content: { type: 'string', description: 'Required for send/update' },
			},
			required: ['action'],
		},
		async call(input): Promise<ToolResult> {
			try {
				let result: any;
				switch (input.action) {
					case 'send':
						result = await client.send(input.conversationId ?? 'default', input.content);
						break;
					case 'update':
						result = await client.updateMessage(input.messageId, input.content);
						break;
					case 'delete':
						result = await client.deleteMessage(input.messageId);
						break;
					default:
						return { content: `Unknown action: ${input.action}`, isError: true };
				}
				return { content: JSON.stringify(result), isError: false, skipSecretRedaction: true };
			} catch (e: any) {
				return { content: e.message, isError: true };
			}
		},
	};
}
