import { readFileSync } from 'fs';
import { CronManager } from './cron.mts';
import { TaskManager, formatTaskYaml } from './tasks.mts';
import { Memory } from './memory.mts';

export interface SystemPromptDeps {
	promptsDir: string;
	cronManager: CronManager;
	taskManager: TaskManager;
	memory: Memory;
}

function readPrompt(promptsDir: string, name: string): string {
	try { return readFileSync(`${promptsDir}/${name}`, 'utf-8').trim(); }
	catch { return ''; }
}

export function buildSystemPrompt({ promptsDir, cronManager, taskManager, memory }: SystemPromptDeps): string {
	const parts = [readPrompt(promptsDir, 'system.md'), readPrompt(promptsDir, 'user.md'), readPrompt(promptsDir, 'widgets.md')];
	const mem = readPrompt(promptsDir, 'memory.md');
	if (mem) parts.push(`# Memory\n${mem}`);
	const crons = cronManager.list();
	if (crons.length) {
		const lines = crons.map(c =>
			`- ${c.name}: "${c.prompt}" (${c.cronHuman}${c.enabled ? '' : ', disabled'})`
		);
		parts.push(`# Scheduled Tasks\n${lines.join('\n')}`);
	}
	const tasks = taskManager.tree();
	const taskBody = tasks.length ? formatTaskYaml(tasks) : 'Task list empty. Use task tool to add long running tasks.';
	parts.push(`# Permanent Tasks\nAgent will get notified periodically until completion of all tasks. Tasks can also be paused.\n${taskBody}`);
	const history = memory.getCompactedHistory();
	if (history) parts.push(`# Conversation History\n${history}`);
	return parts.filter(Boolean).join('\n\n');
}
