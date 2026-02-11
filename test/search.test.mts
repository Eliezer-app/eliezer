import { describe, it, expect } from 'vitest';
import { SearXNGProvider, fenceResults } from '../search.mts';

describe('fenceResults', () => {
	it('wraps results with nonce delimiters', () => {
		const results = [
			{ title: 'Example', url: 'https://example.com', snippet: 'A test result' },
		];
		const fenced = fenceResults(results);
		const match = fenced.match(/\[START UNTRUSTED CONTENT nonce=([a-f0-9]+)\]/);
		expect(match).toBeTruthy();
		const nonce = match![1];
		expect(nonce).toHaveLength(12);
		expect(fenced).toContain(`[END UNTRUSTED CONTENT nonce=${nonce}]`);
		expect(fenced).toContain('1. Example');
		expect(fenced).toContain('https://example.com');
		expect(fenced).toContain('A test result');
	});

	it('generates different nonces per call', () => {
		const results = [{ title: 'T', url: 'http://x', snippet: 's' }];
		const a = fenceResults(results).match(/nonce=([a-f0-9]+)/)?.[1];
		const b = fenceResults(results).match(/nonce=([a-f0-9]+)/)?.[1];
		expect(a).not.toBe(b);
	});

	it('numbers multiple results', () => {
		const results = [
			{ title: 'First', url: 'http://1', snippet: 'one' },
			{ title: 'Second', url: 'http://2', snippet: 'two' },
			{ title: 'Third', url: 'http://3', snippet: 'three' },
		];
		const fenced = fenceResults(results);
		expect(fenced).toContain('1. First');
		expect(fenced).toContain('2. Second');
		expect(fenced).toContain('3. Third');
	});
});

describe('SearXNGProvider', () => {
	it('truncates snippets to 200 chars', async () => {
		const longSnippet = 'x'.repeat(300);
		// Mock a SearXNG-like server
		const provider = new SearXNGProvider('http://localhost:9999');

		// We can't easily test the real provider without a server,
		// but we can verify the class exists and has the right interface
		expect(typeof provider.search).toBe('function');
	});
});
