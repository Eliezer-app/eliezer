import { existsSync } from 'fs';
import { resolve, normalize } from 'path';
import { Tool, ToolResult } from './tools.mts';

export class ChatClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	async send(conversationId: string, content: string, type?: string, attachment?: { filename: string }): Promise<any> {
		return this.request('POST', '/send', { conversationId, content, ...(type ? { type } : {}), ...(attachment ? { attachment } : {}) });
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

export function createChatTool(client: ChatClient, chatPublicDir: string): Tool {
	return {
		name: 'chat',
		description: `Manage chat messages. Actions: update (edit a sent message), delete (remove a message), send (send a message). Avoid using send unless you are sending an attachment — your plain text responses are automatically delivered to chat. To attach a file, write it to ${chatPublicDir}/ and include attachment.filename.`,
		input_schema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['send', 'update', 'delete'] },
				conversationId: { type: 'string', description: 'Required for send' },
				messageId: { type: 'string', description: 'Required for update/delete' },
				content: { type: 'string', description: 'Required for send/update' },
				attachment: { type: 'object', properties: { filename: { type: 'string', description: 'Filename (not path) of a file already written to the chat-public directory' } }, required: ['filename'] },
			},
			required: ['action'],
		},
		async call(input): Promise<ToolResult> {
			try {
				let result: any;
				switch (input.action) {
					case 'send':
						if (input.attachment) {
							const full = resolve(chatPublicDir, input.attachment.filename);
							if (!normalize(full).startsWith(resolve(chatPublicDir) + '/'))
								return { content: 'attachment filename must not escape chat-public directory', isError: true };
							if (!existsSync(full))
								return { content: `attachment not found: ${input.attachment.filename}`, isError: true };
						}
						result = await client.send(input.conversationId ?? 'default', input.content, undefined, input.attachment);
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
