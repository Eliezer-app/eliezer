import { createServer } from 'http';

const port = parseInt(process.env.MOCK_LLM_PORT || '9999');
const calls: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
let nextTool: { name: string; arguments: Record<string, unknown> } | null = null;

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
		nextTool = null;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	// Configure which tool to call next
	if (req.method === 'POST' && req.url === '/next-tool') {
		let body = '';
		req.on('data', (chunk: string) => body += chunk);
		req.on('end', () => {
			nextTool = JSON.parse(body);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		});
		return;
	}

	if (req.method === 'POST' && req.url === '/v1/chat/completions') {
		let body = '';
		req.on('data', (chunk: string) => body += chunk);
		req.on('end', () => {
			const { messages, tools } = JSON.parse(body);
			calls.push({ messages, tools });
			console.log(`← ${messages.length} messages, ${tools?.length ?? 0} tools`);

			const lastMsg = messages[messages.length - 1];
			const isToolResult = lastMsg?.role === 'tool';

			let message: Record<string, unknown>;
			let finish_reason: string;

			if (tools?.length && !isToolResult) {
				const toolName = nextTool?.name ?? tools[0].function.name;
				const toolArgs = nextTool?.arguments ?? mockArgsFor(toolName);
				nextTool = null;

				message = {
					role: 'assistant',
					content: null,
					tool_calls: [{
						id: `call_${calls.length}`,
						type: 'function',
						function: { name: toolName, arguments: JSON.stringify(toolArgs) },
					}],
				};
				finish_reason = 'tool_calls';
			} else {
				message = { role: 'assistant', content: 'Mock LLM response.' };
				finish_reason = 'stop';
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				choices: [{ message, finish_reason }],
				usage: { prompt_tokens: 100, completion_tokens: 20 },
			}));
		});
		return;
	}

	res.writeHead(404);
	res.end();
});

function mockArgsFor(name: string): Record<string, unknown> {
	switch (name) {
		case 'exec': return { command: 'echo hello' };
		case 'read': return { path: '/dev/null' };
		case 'write': return { path: '/tmp/mock-test', content: 'test' };
		case 'chat': return { action: 'send', content: 'Hello from agent' };
		default: return {};
	}
}

server.listen(port, () => console.log(`Mock LLM on :${port}`));
