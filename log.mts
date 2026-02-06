export type Level = 'error' | 'info' | 'debug';

const LEVELS: Record<Level, number> = { error: 0, info: 1, debug: 2 };

const defaultLevel = (process.env.LOG_LEVEL as Level) || 'info';

const moduleLevels: Record<string, Level> = {};
for (const part of (process.env.LOG_LEVELS || '').split(',').filter(Boolean)) {
	const [mod, lvl] = part.split(':');
	if (mod && lvl && lvl in LEVELS) moduleLevels[mod] = lvl as Level;
}

function fmt(v: unknown): string {
	const s = String(v);
	return /[\s"=]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export class Logger {
	private fields: Record<string, string>;
	private level: Level;

	constructor(fields: Record<string, string> = {}, level?: Level) {
		this.fields = fields;
		this.level = level ?? moduleLevels[fields.module] ?? defaultLevel;
	}

	with(fields: Record<string, string>, level?: Level): Logger {
		return new Logger({ ...this.fields, ...fields }, level);
	}

	error(msg: string, extra?: Record<string, unknown>) { this.emit('error', msg, extra); }
	info(msg: string, extra?: Record<string, unknown>) { this.emit('info', msg, extra); }
	debug(msg: string, extra?: Record<string, unknown>) { this.emit('debug', msg, extra); }

	private emit(level: Level, msg: string, extra?: Record<string, unknown>) {
		if (LEVELS[level] > LEVELS[this.level]) return;
		const ts = new Date().toISOString();
		const parts = [`ts=${ts}`, `level=${level}`, `msg=${fmt(msg)}`];
		for (const [k, v] of Object.entries(this.fields)) parts.push(`${k}=${fmt(v)}`);
		if (extra) for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${fmt(v)}`);
		process.stdout.write(parts.join(' ') + '\n');
	}
}
