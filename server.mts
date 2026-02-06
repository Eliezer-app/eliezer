import { createServer, IncomingMessage, ServerResponse } from 'http';
import { EventQueue } from './queue.mts';
import { Logger } from './log.mts';

export function startServer(
	port: number,
	queue: EventQueue,
	getHealth: () => Record<string, unknown>,
	log: Logger,
) {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === 'GET' && req.url === '/health') {
			json(res, 200, getHealth());
			return;
		}

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
