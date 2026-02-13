import { createServer } from 'http';

const port = parseInt(process.env.MOCK_CHAT_PORT || '3100');
const calls: Array<{ method: string; url: string; body: unknown }> = [];

const server = createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', calls: calls.length }));
		return;
	}

	if (req.method === 'GET' && req.url === '/calls') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(calls));
		return;
	}

	if (req.method === 'POST' && req.url === '/reset') {
		calls.length = 0;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	if (req.url === '/send' || req.url === '/agent/state-change' || req.url?.startsWith('/messages/')) {
		let body = '';
		req.on('data', (chunk: string) => body += chunk);
		req.on('end', () => {
			calls.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
			console.log(`← ${req.method} ${req.url}`);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, messageId: `msg_${calls.length}` }));
		});
		return;
	}

	res.writeHead(404);
	res.end();
});

server.listen(port, () => console.log(`Mock Chat on :${port}`));
