import { randomBytes } from 'crypto';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchProvider {
	search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

const SNIPPET_MAX_CHARS = 200;

export class SearXNGProvider implements SearchProvider {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	async search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult[]> {
		const limit = opts?.limit ?? 5;
		const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
		const signals: AbortSignal[] = [AbortSignal.timeout(15_000)];
		if (opts?.signal) signals.push(opts.signal);
		const res = await fetch(url, { signal: AbortSignal.any(signals) });
		if (!res.ok) throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);
		const ct = res.headers.get('content-type') || '';
		if (!ct.includes('application/json')) throw new Error(`SearXNG returned non-JSON response (${ct})`);
		const data = await res.json() as any;
		const results: SearchResult[] = (data.results ?? []).slice(0, limit).map((r: any) => ({
			title: String(r.title ?? '').slice(0, 200),
			url: String(r.url ?? ''),
			snippet: String(r.content ?? '').slice(0, SNIPPET_MAX_CHARS),
		}));
		return results;
	}
}

export function fenceResults(results: SearchResult[]): string {
	const nonce = randomBytes(6).toString('hex');
	const delimiter = 'UNTRUSTED CONTENT';
	const delimiterStart = `[START ${delimiter} nonce=${nonce}]`;
	const delimiterEnd = `[END ${delimiter} nonce=${nonce}]`;
	const lines = results.map((r, i) =>
		`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
	);
	return [delimiterStart, '', ...lines, '', delimiterEnd].join('\n');
}
