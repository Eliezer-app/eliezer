import { createServer, IncomingMessage, ServerResponse } from 'http';
import { EventQueue } from './queue.mts';
import { Logger } from './log.mts';
import { CronRow } from './cron.mts';
import { GroupRow, TaskRow } from './tasks.mts';

export interface ServerDeps {
	port: number;
	queue: EventQueue;
	log: Logger;
	getHealth: () => Record<string, unknown>;
	getState: () => Record<string, unknown>;
	getMemory: () => Record<string, unknown>;
	listCrons: () => CronRow[];
	setCronEnabled: (name: string, enabled: boolean) => boolean;
	listTasks: () => { groups: GroupRow[]; tasks: TaskRow[] };
	stop: () => boolean;
	forget: (messageId: string) => number;
}

export function startServer(deps: ServerDeps) {
	const { port, queue, log, getHealth, getState, getMemory, listCrons, setCronEnabled, listTasks, stop, forget } = deps;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		// GET /info/health — Liveness check. No DB queries.
		//   status  string  — always "ok"
		//   uptime  number  — seconds since process start
		if (req.method === 'GET' && req.url === '/info/health') {
			json(res, 200, getHealth());
			return;
		}

		// GET /info/state — Agent operational state.
		//   currentEvent  {source,type}|null  — event being processed, null when not processing
		//   state         string              — idle | inference | tool_execution | compaction
		//   queueDepth    number              — pending events waiting to be processed
		//   tokensUsed    number              — cumulative LLM tokens consumed since startup
		if (req.method === 'GET' && req.url === '/info/state') {
			json(res, 200, getState());
			return;
		}

		// GET /info/memory — Context memory system stats.
		//   context.system.tokens      number       — tokens used by system prompt (system.md + user.md)
		//   context.system.pct         number       — percentage of budget
		//   context.memory.tokens      number       — tokens used by long-term memory (memory.md)
		//   context.memory.pct         number       — percentage of budget
		//   context.compacted.tokens         number       — tokens used by compressed history summaries
		//   context.compacted.pct            number       — percentage of budget
		//   context.compacted.groups   number       — number of compressed groups
		//   context.flow.tokens        number       — tokens used by uncompressed messages
		//   context.flow.pct           number       — percentage of budget
		//   context.flow.messages      number       — number of uncompressed messages
		//   context.total.tokens       number       — total tokens in use
		//   context.total.pct          number       — total percentage of budget used
		//   context.budget             number       — token budget for context window
		//   archived.messages          number       — messages archived out of context (in DB)
		//   ops.compressions            string[]     — last 10 compress timestamps (newest first)
		//   ops.distillations           string[]     — last 10 distill timestamps (newest first)
		if (req.method === 'GET' && req.url === '/info/memory') {
			json(res, 200, getMemory());
			return;
		}

		// GET /cron — List all scheduled crons.
		//   Array of: { name, command, cron, cronHuman, enabled, last_run, created_at }
		if (req.method === 'GET' && req.url === '/cron') {
			json(res, 200, listCrons());
			return;
		}

		// PUT /cron/:name/enabled — Toggle a cron's enabled state.
		//   Request body: { enabled: boolean }
		//   Response: { ok: true } or 404
		const cronMatch = req.method === 'PUT' && req.url?.match(/^\/cron\/(.+)\/enabled$/);
		if (cronMatch) {
			try {
				const name = decodeURIComponent(cronMatch[1]);
				const body = JSON.parse(await readBody(req));
				const ok = setCronEnabled(name, body.enabled);
				if (!ok) { json(res, 404, { ok: false, error: 'cron not found' }); return; }
				json(res, 200, { ok: true });
			} catch (e: any) {
				json(res, 400, { ok: false, error: e.message });
			}
			return;
		}

		// GET /tasks — Task list (read-only, for chat settings panel).
		//   groups[].id          number       — group ID
		//   groups[].parent_id   number|null  — parent group ID
		//   groups[].title       string       — group title
		//   groups[].created_at  string       — creation timestamp
		//   tasks[].id           number       — task ID
		//   tasks[].group_id     number|null  — parent group ID
		//   tasks[].title        string       — task title
		//   tasks[].details      string       — description
		//   tasks[].status       string       — pending | active | paused | done
		//   tasks[].priority     number       — global priority
		//   tasks[].due_date     string|null  — ISO 8601 date or null
		//   tasks[].created_at   string       — creation timestamp
		if (req.method === 'GET' && req.url === '/tasks') {
			json(res, 200, listTasks());
			return;
		}

		// POST /events — Event ingestion.
		//   Request body:
		//     source     string  — event origin (e.g. "chat")
		//     type       string  — event type
		//     payload    object  — event-specific data (see below)
		//     timestamp  string  — ISO 8601 timestamp
		//   Event types:
		//     user_message     — new message from user
		//       payload.conversationId  string  — conversation ID
		//       payload.messageId       string  — chat message ID (used to link agent reply)
		//       payload.content         string  — message text
		//       payload.attachment      object? — file attachment (optional)
		//         attachment.filename   string  — original filename
		//         attachment.mimetype   string  — MIME type (e.g. "image/jpeg")
		//         attachment.size       number  — file size in bytes
		//     message_updated  — user edited a message (ignored, housekeeping)
		//       payload.messageId  string
		//     message_deleted  — user deleted a message
		//       payload.messageId  string  — removes matching entry from agent memory
		//     typing           — user typing indicator (ignored, housekeeping)
		//   Response:
		//     ok       boolean — true on success
		//     eventId  number  — assigned queue ID
		//   Error (400):
		//     ok       boolean — false
		//     error    string  — error message
		// POST /stop — Abort the current event processing loop.
		//   Response:
		//     ok       boolean — true if an event was being processed
		if (req.method === 'POST' && req.url === '/stop') {
			const stopped = stop();
			log.info('stop requested', { wasProcessing: stopped });
			json(res, 200, { ok: stopped });
			return;
		}

		// POST /forget/from — Delete a message and all messages after it.
		//   Request body:
		//     messageId  string  — chat message ID to forget from
		//   Response:
		//     ok       boolean — true on success
		//     deleted  number  — number of messages removed
		if (req.method === 'POST' && req.url === '/forget/from') {
			try {
				const body = JSON.parse(await readBody(req));
				if (!body.messageId) { json(res, 400, { ok: false, error: 'messageId required' }); return; }
				const deleted = forget(body.messageId);
				log.info('forget/from', { messageId: body.messageId, deleted: String(deleted) });
				json(res, 200, { ok: true, deleted });
			} catch (e: any) {
				json(res, 400, { ok: false, error: e.message });
			}
			return;
		}

		if (req.method === 'POST' && req.url === '/events') {
			try {
				const body = JSON.parse(await readBody(req));
				const id = queue.push(body.source, body.type, body.payload);
				log.info('event received', { source: body.source, type: body.type, id });
				json(res, 200, { ok: true, eventId: id });
			} catch (e: any) {
				json(res, 400, { ok: false, error: e.message });
			}
			return;
		}

		res.writeHead(404);
		res.end();
	});

	server.listen(port, () => log.info(`listening on :${port}`));
	return server;
}

function json(res: ServerResponse, status: number, data: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk: Buffer) => data += chunk);
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}
