import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';

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
	'SELECT chat_message_id, role, content, created_at FROM messages ORDER BY rowid'
).all() as Array<{ chat_message_id: string; role: string; content: string; created_at: number }>;

if (!rows.length) {
	console.error('No messages found');
	process.exit(1);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function formatTime(epoch: number): string {
	const d = new Date(epoch * 1000);
	return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
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

/** Extract user-facing message from event payload string */
function extractUserMessage(text: string): string {
	const nlIdx = text.indexOf('\n');
	if (nlIdx === -1) return text;
	const jsonPart = text.slice(nlIdx + 1);
	try {
		const payload = JSON.parse(jsonPart);
		if (payload.content) return payload.content;
	} catch {}
	return text;
}

// Load image overrides: export/widget-<message-id>.png → data URL
const imageOverrides = new Map<string, string>();
const EXT_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
for (const f of readdirSync('export')) {
	const match = f.match(/^widget-(.+?)(\.\w+)$/);
	if (!match) continue;
	const [, msgId, ext] = match;
	const mime = EXT_MIME[ext.toLowerCase()];
	if (!mime) continue;
	const b64 = readFileSync(`export/${f}`).toString('base64');
	imageOverrides.set(msgId, `data:${mime};base64,${b64}`);
}

const startDate = formatDate(rows[0].created_at);
const endDate = formatDate(rows[rows.length - 1].created_at);

const html: string[] = [];

html.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conversation ${startDate} — ${endDate}</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, system-ui, sans-serif; background: #f0f0f0; color: #1a1a1a; padding: 1rem; font-size: 16px; }
.chat { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 0.25rem; }
h1 { font-size: 0.9rem; text-align: center; color: #999; font-weight: 400; padding: 0.8rem 0 1.2rem; }

/* bubble rows */
.row { display: flex; }
.row.agent { justify-content: flex-start; }
.row.user { justify-content: flex-end; }
.row .wrap { max-width: 95%; }
.bubble { padding: 0.55rem 0.85rem; border-radius: 1.1rem; line-height: 1.45; font-size: 1rem; word-break: break-word; position: relative; }
.bubble p { margin: 0.3rem 0; }
.bubble p:first-child { margin-top: 0; }
.bubble p:last-child { margin-bottom: 0; }
.bubble pre { background: rgba(0,0,0,0.06); padding: 0.5rem; border-radius: 0.4rem; overflow-x: auto; font-size: 0.82rem; margin: 0.3rem 0; white-space: pre-wrap; word-break: break-word; }
.bubble code { font-size: 0.85em; background: rgba(0,0,0,0.06); padding: 0.1rem 0.3rem; border-radius: 0.2rem; }
.bubble pre code { background: none; padding: 0; }
.row.user .bubble pre { background: rgba(255,255,255,0.15); }
.row.user .bubble code { background: rgba(255,255,255,0.15); }
.bubble ul, .bubble ol { padding-left: 1.2rem; margin: 0.3rem 0; }
.bubble blockquote { border-left: 2px solid rgba(0,0,0,0.15); padding-left: 0.6rem; margin: 0.3rem 0; color: inherit; opacity: 0.8; }
.bubble h1, .bubble h2, .bubble h3, .bubble h4 { font-size: 0.95rem; margin: 0.4rem 0 0.2rem; }
.bubble strong { font-weight: 600; }
.bubble .anchor { position: absolute; top: -3rem; }
.row.agent .bubble { background: #fff; color: #1a1a1a; border-bottom-left-radius: 0.2rem; }
.row.user .bubble { background: #3b82f6; color: #fff; border-bottom-right-radius: 0.2rem; }
.time { font-size: 0.7rem; color: #aaa; margin-top: 0.1rem; padding: 0 0.4rem; }
.row.user .time { text-align: right; }
.time a { color: inherit; text-decoration: none; }
.time a:hover { color: #666; }

/* annotations */
.annotation { font-size: 0.82rem; color: #999; padding: 0.15rem 0; max-width: 85%; }
.annotation details { margin: 0; }
.annotation summary { cursor: pointer; color: #aaa; font-size: 0.82rem; }
.annotation summary:hover { color: #666; }
.annotation pre { background: #e4e4e4; color: #555; padding: 0.4rem 0.6rem; border-radius: 0.4rem; overflow-x: auto; font-size: 0.8rem; margin-top: 0.15rem; white-space: pre-wrap; word-break: break-word; max-height: 18rem; overflow-y: auto; }
.tool-tag { display: inline-block; background: #dde4ee; color: #556; padding: 0.05rem 0.4rem; border-radius: 0.25rem; font-size: 0.78rem; margin-right: 0.2rem; }
.bubble img.widget { max-width: 100%; border-radius: 0.6rem; margin: 0.3rem 0; display: block; }
</style>
</head>
<body>
<div class="chat">
<h1>${esc(startDate)} — ${esc(endDate)}</h1>`);

let internals: string[] = [];

function flushInternals() {
	if (!internals.length) return;
	html.push(`<div class="annotation"><details><summary>Internal work</summary>`);
	html.push(internals.join('\n'));
	html.push(`</details></div>`);
	internals = [];
}

for (const row of rows) {
	const time = formatTime(row.created_at);
	const id = row.chat_message_id;
	const { text, blocks } = parseContent(row.content);

	// Plain text message (event payload as string)
	if (text) {
		const side = row.role === 'user' ? 'user' : 'agent';
		const display = row.role === 'user' ? extractUserMessage(text) : text;
		flushInternals();
		html.push(`<div class="row ${side}"><div class="wrap">`);
		html.push(`<div class="bubble" id="${esc(id)}" data-md="${attr(display)}"><span class="anchor"></span>${esc(display)}</div>`);
		html.push(`<div class="time"><a href="#${esc(id)}">${esc(time)}</a></div>`);
		html.push(`</div></div>`);
		continue;
	}

	const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.content).join('');
	const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
	const toolUses = blocks.filter(b => b.type === 'tool_use');
	const toolResults = blocks.filter(b => b.type === 'tool_result');

	if (!reasoning && !texts.length && !toolUses.length && !toolResults.length) continue;

	// Tool results — into internals buffer
	if (toolResults.length) {
		for (const tr of toolResults) {
			const content = tr.content.length > 4000 ? tr.content.slice(0, 4000) + '\n[truncated]' : tr.content;
			const label = tr.tool_use_id ?? 'result';
			internals.push(`<details><summary>${esc(label)}</summary><pre>${esc(content)}</pre></details>`);
		}
		continue;
	}

	// Thinking — into internals buffer
	if (reasoning) {
		internals.push(`<details><summary>thinking...</summary><pre>${esc(reasoning)}</pre></details>`);
	}

	// Tool calls — into internals buffer
	if (toolUses.length) {
		for (const tu of toolUses) {
			const input = JSON.stringify(tu.input);
			const short = input.length > 80 ? input.slice(0, 80) + '\u2026' : input;
			internals.push(`<details><summary><span class="tool-tag">${esc(tu.name)}</span> ${esc(short)}</summary><pre>${esc(JSON.stringify(tu.input, null, 2))}</pre></details>`);
		}
	}

	// Text bubble — flush internals before it
	if (texts.length) {
		const combined = texts.join('\n');
		flushInternals();
		const imgSrc = imageOverrides.get(id);
		html.push(`<div class="row agent"><div class="wrap">`);
		if (imgSrc) {
			html.push(`<div class="bubble" id="${esc(id)}"><span class="anchor"></span><img class="widget" src="${imgSrc}"></div>`);
		} else {
			html.push(`<div class="bubble" id="${esc(id)}" data-md="${attr(combined)}"><span class="anchor"></span>${esc(combined)}</div>`);
		}
		html.push(`<div class="time"><a href="#${esc(id)}">${esc(time)}</a></div>`);
		html.push(`</div></div>`);
	}
}
flushInternals();

html.push(`</div>
<script>
marked.setOptions({ breaks: true, gfm: true });
document.querySelectorAll('.bubble[data-md]').forEach(el => {
	el.innerHTML = marked.parse(el.getAttribute('data-md'));
});
</script>
</body></html>`);

const filename = `export/${startDate}_${endDate}.html`;
mkdirSync('export', { recursive: true });
writeFileSync(filename, redact(html.join('\n')));
console.log(filename);
