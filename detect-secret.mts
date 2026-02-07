interface SecretPattern {
	name: string;
	pattern: RegExp;
	replacement?: string;
}

// Layer 1: Known key formats — always redact, even with skipSecretRedaction
export const patterns: SecretPattern[] = [
	// Cloud providers
	{ name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },

	// AI providers
	{ name: 'openai-anthropic-key', pattern: /sk-[a-zA-Z0-9_-]{20,}/g },

	// GitHub
	{ name: 'github-pat', pattern: /gh[pours]_[a-zA-Z0-9]{36,}/g },
	{ name: 'github-fine-grained', pattern: /github_pat_[a-zA-Z0-9_]{22,}/g },

	// Slack
	{ name: 'slack-token', pattern: /xox[bpars]-[a-zA-Z0-9-]{10,}/g },

	// Stripe
	{ name: 'stripe-key', pattern: /[sr]k_live_[a-zA-Z0-9]{24,}/g },

	// Auth
	{ name: 'bearer-token', pattern: /Bearer [a-zA-Z0-9_.=-]{20,}/g },
	{ name: 'jwt', pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },

	// Private keys
	{ name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },

	// Env-style: KEY=value (redact value only)
	{ name: 'env-secret', pattern: /(?<=[_.](?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)\s*[=:]\s*)\S+/gi },

	// JSON-style: "password": "value" (redact value only)
	{ name: 'json-secret', pattern: /(?<="(?:password|secret|token|api_key|apikey|credential|auth)"\s*:\s*")[^"]+/gi },
];

// Layer 3: Exclusions — known safe high-entropy patterns
const exclusions: RegExp[] = [
	/^[0-9a-f]{40}$/,                        // git SHA
	/^[0-9a-f]{64}$/,                        // SHA-256
	/^[0-9a-f]{7,12}$/,                      // short git SHA
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
	/^sha[0-9]*:[0-9a-f]+$/,                 // Docker digest
	/^[A-Za-z0-9+/]+=*$/,                    // pure base64 (no mixed special chars)
	/^0x[0-9a-fA-F]+$/,                      // hex literal
	/^[a-zA-Z0-9_-]+\.[a-zA-Z]{2,}$/,       // domain-like (foo.com)
	/^\/[\w/.-]+$/,                           // file path
	/^[a-zA-Z]+[^a-zA-Z]?$/,                 // single word with optional trailing punctuation
];

// Layer 2: High-entropy heuristic — 12+ chars, 3+ char classes, no whitespace
function hasHighEntropy(token: string): boolean {
	if (token.length < 12) return false;
	let classes = 0;
	if (/[a-z]/.test(token)) classes++;
	if (/[A-Z]/.test(token)) classes++;
	if (/[0-9]/.test(token)) classes++;
	if (/[^a-zA-Z0-9]/.test(token)) classes++;
	return classes >= 4;
}

function isExcluded(token: string): boolean {
	return exclusions.some(re => re.test(token));
}

/**
 * Redact secrets from text.
 * Layer 1 (known patterns) always runs.
 * Layer 2 (entropy heuristic) skipped if skipEntropy is true.
 */
export function redactSecrets(text: string, skipEntropy = false): string {
	let result = text;

	// Layer 1: known patterns — always
	for (const { pattern, replacement } of patterns) {
		pattern.lastIndex = 0;
		result = result.replace(pattern, replacement ?? '[REDACTED]');
	}

	// Layer 2: entropy heuristic
	if (!skipEntropy) {
		result = result.replace(/\S{12,}/g, (token) => {
			if (!hasHighEntropy(token)) return token;
			if (isExcluded(token)) return token;
			return '[REDACTED]';
		});
	}

	return result;
}
