interface SecretPattern {
	name: string;
	pattern: RegExp;
	replacement?: string;
}

// Layer 1: Known key formats — always redact, even with skipSecretRedaction
export const patterns: SecretPattern[] = [
	// Cloud providers
	{ name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
	{ name: 'google-api-key', pattern: /AIza[0-9A-Za-z\-_]{35}/g },
	{ name: 'google-oauth', pattern: /ya29\.[0-9A-Za-z\-_]+/g },

	// AI providers
	{ name: 'openai-anthropic-key', pattern: /sk-[a-zA-Z0-9_-]{20,}/g },

	// GitHub
	{ name: 'github-pat', pattern: /gh[pours]_[a-zA-Z0-9]{36,}/g },
	{ name: 'github-fine-grained', pattern: /github_pat_[a-zA-Z0-9_]{22,}/g },

	// Slack
	{ name: 'slack-token', pattern: /xox[bpars]-[a-zA-Z0-9-]{10,}/g },
	{ name: 'slack-webhook', pattern: /hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8,}\/B[a-zA-Z0-9_]{8,}\/[a-zA-Z0-9_]{24,}/g },

	// Stripe
	{ name: 'stripe-key', pattern: /[sr]k_live_[a-zA-Z0-9]{24,}/g },

	// Communication
	{ name: 'twilio-key', pattern: /SK[0-9a-fA-F]{32}/g },
	{ name: 'sendgrid-key', pattern: /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/g },
	{ name: 'mailgun-key', pattern: /key-[0-9a-zA-Z]{32}/g },
	{ name: 'telegram-bot', pattern: /\d{8,10}:[A-Za-z0-9_-]{35}/g },

	// Platforms
	{ name: 'discord-token', pattern: /[MN][A-Za-z0-9]{23,}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}/g },
	{ name: 'npm-token', pattern: /npm_[a-zA-Z0-9]{36,}/g },
	{ name: 'supabase-key', pattern: /sbp_[a-zA-Z0-9]{40,}/g },
	{ name: 'datadog-key', pattern: /dd[a-z]{1,2}_[a-zA-Z0-9]{32,}/g },

	// Auth
	{ name: 'bearer-token', pattern: /Bearer [a-zA-Z0-9_.=-]{20,}/g },
	{ name: 'jwt', pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },

	// Private keys
	{ name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },

	// Password hashes
	{ name: 'bcrypt', pattern: /\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/g, replacement: '[REDACTED HASH]' },
	{ name: 'argon2', pattern: /\$argon2[id]{1,2}\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+/g, replacement: '[REDACTED HASH]' },
	{ name: 'scrypt', pattern: /\$scrypt\$[^\s]+/g, replacement: '[REDACTED HASH]' },
	{ name: 'pbkdf2', pattern: /\$pbkdf2-sha(?:256|512)\$[^\s]+/g, replacement: '[REDACTED HASH]' },
	{ name: 'md5crypt', pattern: /\$1\$[./A-Za-z0-9]{8}\$[./A-Za-z0-9]{22}/g, replacement: '[REDACTED HASH]' },
	{ name: 'sha256crypt', pattern: /\$5\$(?:rounds=\d+\$)?[^\s$]+\$[./A-Za-z0-9]{43}/g, replacement: '[REDACTED HASH]' },
	{ name: 'sha512crypt', pattern: /\$6\$(?:rounds=\d+\$)?[^\s$]+\$[./A-Za-z0-9]{86}/g, replacement: '[REDACTED HASH]' },

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
	/^[A-Za-z0-9+/]*[+/=][A-Za-z0-9+/=]*$/,  // base64 (must contain +, /, or =)
	/^0x[0-9a-fA-F]+$/,                      // hex literal
	/^[a-zA-Z0-9_-]+\.[a-zA-Z]{2,}$/,       // domain-like (foo.com)
	/^[\w.-]+(?:\/[\w.-]+){2,}$/,              // file path (3+ segments, e.g. tmp/wget-x/file.db)
	/^[a-zA-Z]+[^a-zA-Z]?$/,                 // single word with optional trailing punctuation
	/^https?:\/\//,                           // URL
	/^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+/,     // email or git remote (user@host)
	/^[a-zA-Z][\w-]*:[a-zA-Z#]/,            // key:Value or key:#hex style
	/^at_?\w/,                               // stack trace (at Object.method...)
	/^[A-Z][A-Z0-9]+_[A-Z][A-Z0-9]+_/,      // UPPER_SNAKE_CASE prefix (env vars, constants)
];

// Layer 2: Suspicion scoring — combines Shannon entropy, char class diversity, and vowel ratio

function shannonEntropy(s: string): number {
	const freq = new Map<string, number>();
	for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
	let e = 0;
	for (const count of freq.values()) {
		const p = count / s.length;
		e -= p * Math.log2(p);
	}
	return e;
}

const SUSPICION_THRESHOLD = 2.95;

function suspicionScore(token: string): number {
	let s = 0;

	// Shannon entropy (0 ~ 2 pts)
	s += Math.max(0, shannonEntropy(token) - 2.5);

	// Char class diversity (0 ~ 1 pt)
	let classes = 0;
	if (/[a-z]/.test(token)) classes++;
	if (/[A-Z]/.test(token)) classes++;
	if (/[0-9]/.test(token)) classes++;
	if (/[^a-zA-Z0-9]/.test(token)) classes++;
	s += Math.max(0, classes - 2) * 0.5;

	// Low vowel ratio (0 ~ 2 pts)
	const letters = token.replace(/[^a-zA-Z]/g, '');
	if (letters.length >= 3) {
		const vowels = letters.replace(/[^aeiouAEIOU]/g, '').length;
		const ratio = vowels / letters.length;
		s += Math.max(0, 0.35 - ratio) * 6;
	}

	return s;
}

function isExcluded(token: string): boolean {
	return exclusions.some(re => re.test(token));
}

/**
 * Redact secrets from text.
 * Layer 1 (known patterns) always runs.
 * Layer 2 (suspicion scoring) skipped if skipEntropy is true.
 */
export function redactSecrets(text: string, skipEntropy = false): string {
	let result = text;

	// Layer 1: known patterns — always
	for (const { pattern, replacement } of patterns) {
		pattern.lastIndex = 0;
		result = result.replace(pattern, replacement ?? '[REDACTED]');
	}

	// Layer 2: suspicion scoring
	if (!skipEntropy) {
		result = result.replace(/[a-zA-Z0-9][^\s"'`]{11,}/g, (token) => {
			const core = token.replace(/[^a-zA-Z0-9]+$/g, '');
			if (suspicionScore(core) < SUSPICION_THRESHOLD) return token;
			if (isExcluded(core)) return token;
			return '[REDACTED]';
		});
	}

	return result;
}
