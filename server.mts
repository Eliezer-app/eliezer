import { createServer, IncomingMessage, ServerResponse } from 'http';
import { EventQueue } from './queue.mts';
import { Logger } from './log.mts';

export interface ServerDeps {
	port: number;
	queue: EventQueue;
	log: Logger;
	getHealth: () => Record<string, unknown>;
	getState: () => Record<string, unknown>;
	getMemory: () => Record<string, unknown>;
}

export function startServer(deps: ServerDeps) {
	const { port, queue, log, getHealth, getState, getMemory } = deps;

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
		//   context.compacted.tokens   number       — tokens used by compressed history summaries
		//   context.compacted.pct      number       — percentage of budget
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

		// POST /events — Event ingestion.
		//   Request body:
		//     source   string  — event origin (e.g. "chat")
		//     type     string  — event type (e.g. "user_message", "message_deleted")
		//     payload  object  — event-specific data
		//   Response:
		//     ok       boolean — true on success
		//     eventId  number  — assigned queue ID
		//   Error (400):
		//     ok       boolean — false
		//     error    string  — error message
		if (req.method === 'POST' && req.url === '/events') {
			try {
				const body = JSON.parse(await readBody(req));
				const id = queue.push(body.source, body.type, body.payload);
				log.debug('event received', { source: body.source, type: body.type, id });
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
