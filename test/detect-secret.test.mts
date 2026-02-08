import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../detect-secret.mts';

describe('redactSecrets', () => {
	it('leaves normal text unchanged', () => {
		const text = 'Hello world, this is a normal log line.';
		expect(redactSecrets(text)).toBe(text);
	});

	it('redacts AWS access key', () => {
		expect(redactSecrets('key is AKIAIOSFODNN7EXAMPLE')).toBe('key is [REDACTED]');
	});

	it('redacts OpenAI/Anthropic key', () => {
		expect(redactSecrets('sk-proj-abc123def456ghi789jkl012')).toBe('[REDACTED]');
	});

	it('redacts GitHub PAT', () => {
		expect(redactSecrets('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')).toBe('token: [REDACTED]');
	});

	it('redacts GitHub fine-grained PAT', () => {
		expect(redactSecrets('github_pat_11AAAAAA0abcdefghijklmnopqrs')).toBe('[REDACTED]');
	});

	it('redacts Slack token', () => {
		expect(redactSecrets('xoxb-123456789-abcdefgh')).toBe('[REDACTED]');
	});

	it('redacts Stripe key', () => {
		expect(redactSecrets('sk_live_abcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]');
	});

	it('redacts Bearer token', () => {
		expect(redactSecrets('Authorization: Bearer eyabcdef1234567890.token')).toBe('Authorization: [REDACTED]');
	});

	it('redacts JWT', () => {
		expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'))
			.toBe('[REDACTED]');
	});

	it('redacts private key block', () => {
		const text = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj
-----END PRIVATE KEY-----`;
		expect(redactSecrets(text)).toBe('[REDACTED PRIVATE KEY]');
	});

	it('redacts RSA private key block', () => {
		const text = `-----BEGIN RSA PRIVATE KEY-----
MIIEvQIBADANBg
-----END RSA PRIVATE KEY-----`;
		expect(redactSecrets(text)).toBe('[REDACTED PRIVATE KEY]');
	});

	it('redacts env-style secret values', () => {
		expect(redactSecrets('MY_API_KEY=somesecretvalue123')).toBe('MY_API_KEY=[REDACTED]');
		expect(redactSecrets('DB_PASSWORD: hunter2')).toBe('DB_PASSWORD: [REDACTED]');
		expect(redactSecrets('AUTH_TOKEN=abc123def')).toBe('AUTH_TOKEN=[REDACTED]');
	});

	it('redacts JSON-style secret values', () => {
		expect(redactSecrets('"password": "hunter2"')).toBe('"password": "[REDACTED]"');
		expect(redactSecrets('"api_key": "abc123"')).toBe('"api_key": "[REDACTED]"');
		expect(redactSecrets('"secret": "mysecret"')).toBe('"secret": "[REDACTED]"');
	});

	it('handles multiple secrets in one text', () => {
		const text = 'AWS_SECRET_KEY=abc123 and token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
		const result = redactSecrets(text);
		expect(result).not.toContain('abc123');
		expect(result).not.toContain('ghp_');
	});

	it('is idempotent', () => {
		const text = 'sk-proj-abc123def456ghi789jkl012';
		const once = redactSecrets(text);
		const twice = redactSecrets(once);
		expect(once).toBe(twice);
	});

	describe('entropy heuristic', () => {
		it('redacts high-entropy tokens (mixed char classes, 12+ chars)', () => {
			expect(redactSecrets('secret: awTy2%f6kddDtgr')).toBe('secret: [REDACTED]');
		});

		it('leaves low-entropy tokens alone', () => {
			expect(redactSecrets('hello_world_foo')).toBe('hello_world_foo');
		});

		it('excludes git SHAs', () => {
			expect(redactSecrets('abc1234567890abcdef1234567890abcdef123456')).toBe('abc1234567890abcdef1234567890abcdef123456');
		});

		it('excludes short git SHAs', () => {
			expect(redactSecrets('abc1234567')).toBe('abc1234567');
		});

		it('excludes UUIDs', () => {
			expect(redactSecrets('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('excludes UUIDs with surrounding punctuation', () => {
			expect(redactSecrets('53bd7dda-b8c4-4bf2-a5af-93ebf5064dbd}')).toBe('53bd7dda-b8c4-4bf2-a5af-93ebf5064dbd}');
			expect(redactSecrets('<53bd7dda-b8c4-4bf2-a5af-93ebf5064dbd>')).toBe('<53bd7dda-b8c4-4bf2-a5af-93ebf5064dbd>');
		});

		it('excludes UUIDs in compact JSON', () => {
			const json = '{"messageId":"53bd7dda-b8c4-4bf2-a5af-93ebf5064dbd"}';
			expect(redactSecrets(json)).toBe(json);
		});

		it('excludes file paths', () => {
			expect(redactSecrets('/usr/local/bin/node')).toBe('/usr/local/bin/node');
		});

		it('skipped with skipEntropy flag', () => {
			expect(redactSecrets('awTy2%f6kddDtgr', true)).toBe('awTy2%f6kddDtgr');
		});

		it('known patterns still redact even with skipEntropy', () => {
			expect(redactSecrets('sk-proj-abc123def456ghi789jkl012', true)).toBe('[REDACTED]');
		});
	});
});
