import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

// Collect secrets to redact from .env (values longer than 8 chars)
const secrets: string[] = [];
try {
	const envContent = readFileSync('.env', 'utf-8');
	for (const line of envContent.split('\n')) {
		const match = line.match(/^\s*\w+=(.+)$/);
		if (!match) continue;
		const val = match[1].trim().replace(/^["']|["']$/g, '');
		if (val.length > 8) secrets.push(val);
	}
} catch {}

function redact(s: string): string {
	for (const secret of secrets) {
		s = s.replaceAll(secret, '[REDACTED]');
	}
	return s;
}

const dbPath = process.argv[2] || './state/eliezer.db';
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(
	'SELECT role, content, created_at FROM messages ORDER BY rowid'
).all() as Array<{ role: string; content: string; created_at: number }>;

if (!rows.length) {
	console.error('No messages found');
	process.exit(1);
}

function formatTime(epoch: number): string {
	return new Date(epoch * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function formatDate(epoch: number): string {
	return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function parseContent(raw: string): { text: string; blocks: any[] } {
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return { text: '', blocks: parsed };
	} catch {}
	return { text: raw, blocks: [] };
}

const lines: string[] = [];
const startDate = formatDate(rows[0].created_at);
const endDate = formatDate(rows[rows.length - 1].created_at);

lines.push(`# Conversation ${startDate} to ${endDate}`);
lines.push('');

for (const row of rows) {
	const time = formatTime(row.created_at);
	const { text, blocks } = parseContent(row.content);

	if (text) {
		const label = row.role === 'user' ? 'User' : 'Eliezer';
		lines.push(`### ${label} — ${time}`);
		lines.push('');
		lines.push(text);
		lines.push('');
		continue;
	}

	// Structured content blocks
	const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.content).join('');
	const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
	const toolUses = blocks.filter(b => b.type === 'tool_use');
	const toolResults = blocks.filter(b => b.type === 'tool_result');

	if (!reasoning && !texts.length && !toolUses.length && !toolResults.length) continue;

	const label = row.role === 'user' ? 'User' : 'Eliezer';

	if (toolResults.length) {
		for (const tr of toolResults) {
			lines.push(`#### Tool result — ${time}`);
			lines.push('');
			lines.push('```');
			lines.push(tr.content.length > 2000 ? tr.content.slice(0, 2000) + '\n[truncated]' : tr.content);
			lines.push('```');
			lines.push('');
		}
		continue;
	}

	lines.push(`### ${label} — ${time}`);
	lines.push('');

	if (reasoning) {
		lines.push('<details><summary>Thinking</summary>');
		lines.push('');
		lines.push(reasoning);
		lines.push('');
		lines.push('</details>');
		lines.push('');
	}

	for (const t of texts) {
		lines.push(t);
		lines.push('');
	}

	for (const tu of toolUses) {
		lines.push(`**Tool: ${tu.name}**`);
		lines.push('```json');
		lines.push(JSON.stringify(tu.input, null, 2));
		lines.push('```');
		lines.push('');
	}
}

const filename = `export/${startDate}_${endDate}.md`;
import { mkdirSync, writeFileSync } from 'fs';
mkdirSync('export', { recursive: true });
writeFileSync(filename, redact(lines.join('\n')));
console.log(filename);
