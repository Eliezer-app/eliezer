import { existsSync } from 'fs';
import { resolve, normalize } from 'path';
import Database from 'better-sqlite3';
import { ToolBase, ToolResult } from './tools.mts';

export class ChatClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	async send(content: string, type?: string, attachment?: { filename: string }, signal?: AbortSignal): Promise<any> {
		return this.request('POST', '/agent/send', { role: 'agent', content, ...(type ? { type } : {}), ...(attachment ? { attachment } : {}) }, signal);
	}

	async updateMessage(messageId: string, content: string, signal?: AbortSignal): Promise<any> {
		return this.request('PATCH', `/messages/${messageId}`, { content }, signal);
	}

	async deleteMessage(messageId: string, signal?: AbortSignal): Promise<any> {
		return this.request('DELETE', `/messages/${messageId}`, undefined, signal);
	}

	async stateChange(state: string): Promise<any> {
		return this.request('POST', '/state-changed', { state });
	}

	private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {}),
			signal,
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

export class ChatTool extends ToolBase {
	name = 'chat';
	defaultTimeout = 15;
	description: string;
	input_schema = {
		type: 'object',
		properties: {
			action: { type: 'string', enum: ['send', 'update', 'delete'] },
			match: { type: 'string', description: 'Substring to find the message. Required for update/delete' },
			content: { type: 'string', description: 'Required for send/update' },
			attachment: { type: 'object', properties: { filename: { type: 'string', description: 'Filename (not path) of a file already written to the chat-public directory' } }, required: ['filename'] },
		},
		required: ['action'],
	};

	private client: ChatClient;
	private chatPublicDir: string;
	private db: Database.Database;

	constructor(client: ChatClient, chatPublicDir: string, db: Database.Database) {
		super();
		this.client = client;
		this.chatPublicDir = chatPublicDir;
		this.db = db;
		this.description = `Manage chat messages. Actions: update (edit a sent message), delete (remove a message), send (send a message). Avoid using send unless you are sending an attachment — your plain text responses are automatically delivered to chat. To attach a file, write it to ${chatPublicDir}/ and include attachment.filename. For update/delete, provide a "match" string (substring of the message). If multiple messages match, the call is rejected — use a more specific match.`;
	}

	async call(input: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
		try {
			let result: any;
			switch (input.action) {
				case 'send':
					if (input.attachment) {
						const full = resolve(this.chatPublicDir, input.attachment.filename);
						if (!normalize(full).startsWith(resolve(this.chatPublicDir) + '/'))
							return { content: 'attachment filename must not escape chat-public directory', isError: true };
						if (!existsSync(full))
							return { content: `attachment not found: ${input.attachment.filename}`, isError: true };
					}
					result = await this.client.send(input.content, undefined, input.attachment, signal);
					break;
				case 'update': {
					const found = findMessageByMatch(this.db, input.match);
					if ('error' in found) return { content: found.error, isError: true };
					result = await this.client.updateMessage(found.id, input.content, signal);
					break;
				}
				case 'delete': {
					const found = findMessageByMatch(this.db, input.match);
					if ('error' in found) return { content: found.error, isError: true };
					result = await this.client.deleteMessage(found.id, signal);
					break;
				}
				default:
					return { content: `Unknown action: ${input.action}`, isError: true };
			}
			return { content: JSON.stringify(result), isError: false, skipSecretRedaction: true };
		} catch (e: any) {
			return { content: e.message, isError: true };
		}
	}
}
