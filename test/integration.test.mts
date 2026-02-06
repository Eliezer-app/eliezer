import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const MOCK_LLM = 'http://localhost:9999';
const MOCK_CHAT = 'http://localhost:4100';
const AGENT = 'http://localhost:3200';

async function waitForHealth(url: string, timeoutMs = 30_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) return;
		} catch {}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`${url} did not become healthy within ${timeoutMs}ms`);
}

async function waitForCalls(url: string, minCalls: number, timeoutMs = 10_000): Promise<any[]> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const calls = await fetch(`${url}/calls`).then(r => r.json());
		if (calls.length >= minCalls) return calls;
		await new Promise(r => setTimeout(r, 200));
	}
	throw new Error(`Expected ${minCalls} calls to ${url} within ${timeoutMs}ms`);
}

function postEvent(source: string, type: string, payload = {}) {
	return fetch(`${AGENT}/events`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ source, type, payload }),
	});
}

describe('agent integration', () => {
	beforeAll(async () => {
		await waitForHealth(MOCK_LLM);
		await waitForHealth(MOCK_CHAT);
		await waitForHealth(AGENT);
	}, 60_000);

	beforeEach(async () => {
		await fetch(`${MOCK_LLM}/reset`, { method: 'POST' });
		await fetch(`${MOCK_CHAT}/reset`, { method: 'POST' });
	});

	it('agent is healthy', async () => {
		const body = await fetch(`${AGENT}/health`).then(r => r.json());
		expect(body.status).toBe('ok');
		expect(body).toHaveProperty('uptime');
		expect(body).toHaveProperty('queueDepth');
		expect(body).toHaveProperty('tokensUsed');
	});

	it('event → LLM call → text auto-sent to chat', async () => {
		const res = await postEvent('test', 'user_message', { content: 'Hello agent' });
		expect(res.ok).toBe(true);
		expect((await res.json()).eventId).toBeDefined();

		const calls = await waitForCalls(MOCK_LLM, 1);
		const messages = calls[0].messages;
		expect(messages[0].role).toBe('system');
		expect(messages[1].role).toBe('user');
		expect(messages[1].content).toContain('Hello agent');

		// Text response should be auto-sent to chat
		const chatCalls = await waitForCalls(MOCK_CHAT, 1);
		expect(chatCalls[0].method).toBe('POST');
		expect(chatCalls[0].url).toBe('/api/agent/send');
		expect(chatCalls[0].body.content).toBeDefined();
	}, 15_000);

	it('tool loop: LLM calls tool → result fed back', async () => {
		await postEvent('test', 'ping');

		const calls = await waitForCalls(MOCK_LLM, 2);
		expect(calls).toHaveLength(2);

		const toolResultMsg = calls[1].messages.find((m: any) => m.role === 'tool');
		expect(toolResultMsg).toBeDefined();
		expect(toolResultMsg.content).toBeDefined();
	}, 15_000);

	it('chat tool: LLM calls chat → message sent to chat server', async () => {
		// Tell mock LLM to call the chat tool next
		await fetch(`${MOCK_LLM}/next-tool`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'chat', arguments: { action: 'send', conversationId: 'default', content: 'Hello from agent' } }),
		});

		await postEvent('test', 'user_message', { content: 'Say hello' });

		// Agent should call mock chat server
		const chatCalls = await waitForCalls(MOCK_CHAT, 1);
		expect(chatCalls[0].method).toBe('POST');
		expect(chatCalls[0].url).toBe('/api/agent/send');
		expect(chatCalls[0].body.content).toBe('Hello from agent');
		expect(chatCalls[0].body.conversationId).toBe('default');
	}, 15_000);

	it('memory: second event includes context from first', async () => {
		await postEvent('test', 'user_message', { content: 'first message' });
		await waitForCalls(MOCK_LLM, 2); // tool call + response
		await fetch(`${MOCK_LLM}/reset`, { method: 'POST' });

		await postEvent('test', 'user_message', { content: 'second message' });
		const calls = await waitForCalls(MOCK_LLM, 1);

		// The LLM call should contain messages from both events
		const messages = calls[0].messages;
		const userMessages = messages.filter((m: any) => m.role === 'user');
		const hasFirst = userMessages.some((m: any) => typeof m.content === 'string' && m.content.includes('first message'));
		const hasSecond = userMessages.some((m: any) => typeof m.content === 'string' && m.content.includes('second message'));
		expect(hasFirst).toBe(true);
		expect(hasSecond).toBe(true);
	}, 15_000);

	it('health reports token usage after LLM calls', async () => {
		await postEvent('test', 'ping');
		await waitForCalls(MOCK_LLM, 2);

		const body = await fetch(`${AGENT}/health`).then(r => r.json());
		expect(body.tokensUsed).toBeGreaterThan(0);
	}, 15_000);
});
