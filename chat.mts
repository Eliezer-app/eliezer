import { existsSync } from 'fs';
import { resolve, normalize } from 'path';
import Database from 'better-sqlite3';
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
		return this.request('POST', '/state-changed', { state });
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

function findMessageByMatch(db: Database.Database, match: string): { id: string } | { error: string } {
	const rows = db.prepare(
		'SELECT chat_message_id FROM messages WHERE role = ? AND content LIKE ? AND NOT archived'
	).all('assistant', `%${match}%`) as Array<{ chat_message_id: string }>;
	if (rows.length === 0) return { error: 'No messages match the given text' };
	if (rows.length > 1) return { error: `${rows.length} messages match — provide a more specific match string` };
	return { id: rows[0].chat_message_id };
}

export function createChatTool(client: ChatClient, chatPublicDir: string, db: Database.Database): Tool {
	return {
		name: 'chat',
		description: `Manage chat messages. Actions: update (edit a sent message), delete (remove a message), send (send a message). Avoid using send unless you are sending an attachment — your plain text responses are automatically delivered to chat. To attach a file, write it to ${chatPublicDir}/ and include attachment.filename. For update/delete, provide a "match" string (substring of the message). If multiple messages match, the call is rejected — use a more specific match.`,
		input_schema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['send', 'update', 'delete'] },
				conversationId: { type: 'string', description: 'Required for send' },
				match: { type: 'string', description: 'Substring to find the message. Required for update/delete' },
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
					case 'update': {
						const found = findMessageByMatch(db, input.match);
						if ('error' in found) return { content: found.error, isError: true };
						result = await client.updateMessage(found.id, input.content);
						break;
					}
					case 'delete': {
						const found = findMessageByMatch(db, input.match);
						if ('error' in found) return { content: found.error, isError: true };
						result = await client.deleteMessage(found.id);
						break;
					}
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
