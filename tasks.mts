import Database from 'better-sqlite3';
import { ToolBase, ToolResult } from './tools.mts';

export interface GroupRow {
	id: number;
	parent_id: number | null;
	title: string;
	created_at: string;
}

export interface TaskRow {
	id: number;
	group_id: number | null;
	title: string;
	details: string;
	status: string;
	priority: number;
	due_date: string | null;
	created_at: string;
}

export interface TreeNode {
	kind: 'group' | 'task';
	id: number;
	title: string;
	status?: string;
	details?: string;
	priority?: number;
	due_date?: string | null;
	children: TreeNode[];
}

export class TaskManager {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		db.pragma('foreign_keys = ON');
		// Migration: drop old single-table model (only test data)
		const old = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() as any;
		if (old) {
			const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
			if (cols.some(c => c.name === 'parent_id')) {
				db.exec('DROP TABLE tasks');
			}
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS task_groups (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				parent_id INTEGER REFERENCES task_groups(id) ON DELETE CASCADE,
				title TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE IF NOT EXISTS tasks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id INTEGER REFERENCES task_groups(id) ON DELETE CASCADE,
				title TEXT NOT NULL,
				details TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending',
				priority INTEGER NOT NULL DEFAULT 0,
				due_date TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
	}

	createGroup(title: string, parentId?: number): number {
		return this.db.prepare(
			'INSERT INTO task_groups (title, parent_id) VALUES (?, ?)'
		).run(title, parentId ?? null).lastInsertRowid as number;
	}

	deleteGroup(id: number): boolean {
		return this.db.prepare('DELETE FROM task_groups WHERE id = ?').run(id).changes > 0;
	}

	createTask(title: string, details = '', groupId?: number, priority = 0, dueDate?: string): number {
		return this.db.prepare(
			'INSERT INTO tasks (title, details, group_id, priority, due_date) VALUES (?, ?, ?, ?, ?)'
		).run(title, details, groupId ?? null, priority, dueDate ?? null).lastInsertRowid as number;
	}

	updateTask(id: number, fields: Partial<Pick<TaskRow, 'title' | 'details' | 'status' | 'priority' | 'group_id' | 'due_date'>>): boolean {
		const sets: string[] = [];
		const vals: any[] = [];
		for (const [key, val] of Object.entries(fields)) {
			if (val === undefined) continue;
			sets.push(`${key} = ?`);
			vals.push(val);
		}
		if (!sets.length) return false;
		vals.push(id);
		return this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
	}

	completeTask(id: number): boolean {
		return this.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id).changes > 0;
	}

	deleteTask(id: number): boolean {
		return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
	}

	pending(): TaskRow[] {
		return this.db.prepare(
			"SELECT * FROM tasks WHERE status IN ('pending', 'active') ORDER BY priority, id"
		).all() as TaskRow[];
	}

	listAll(): { groups: GroupRow[]; tasks: TaskRow[] } {
		return {
			groups: this.db.prepare('SELECT * FROM task_groups ORDER BY id').all() as GroupRow[],
			tasks: this.db.prepare('SELECT * FROM tasks ORDER BY priority, id').all() as TaskRow[],
		};
	}

	tree(): TreeNode[] {
		const { groups, tasks } = this.listAll();

		const groupNodes = new Map<number, TreeNode>();
		for (const g of groups) groupNodes.set(g.id, { kind: 'group', id: g.id, title: g.title, children: [] });

		const roots: TreeNode[] = [];
		for (const node of groupNodes.values()) {
			const g = groups.find(r => r.id === node.id)!;
			if (g.parent_id && groupNodes.has(g.parent_id)) {
				groupNodes.get(g.parent_id)!.children.push(node);
			} else {
				roots.push(node);
			}
		}

		for (const t of tasks) {
			const node: TreeNode = { kind: 'task', id: t.id, title: t.title, status: t.status, details: t.details, priority: t.priority, due_date: t.due_date, children: [] };
			if (t.group_id && groupNodes.has(t.group_id)) {
				groupNodes.get(t.group_id)!.children.push(node);
			} else {
				roots.push(node);
			}
		}

		return roots;
	}
}

function formatTree(nodes: TreeNode[], indent = ''): string {
	const lines: string[] = [];
	for (const node of nodes) {
		if (node.kind === 'group') {
			lines.push(`${indent}▸ [g${node.id}] ${node.title}`);
		} else {
			const due = node.due_date ? ` (due: ${node.due_date})` : '';
			lines.push(`${indent}[${node.status}] #${node.id} ${node.title}${due}`);
		}
		if (node.children.length) lines.push(formatTree(node.children, indent + '  '));
	}
	return lines.join('\n');
}

export function formatTaskTree(tree: TreeNode[]): string {
	return formatTree(tree);
}

function formatYaml(nodes: TreeNode[], indent = ''): string {
	const lines: string[] = [];
	for (const node of nodes) {
		if (node.kind === 'group') {
			lines.push(`${indent}- group: g${node.id} ${node.title}`);
			if (node.children.length) {
				lines.push(`${indent}  tasks:`);
				lines.push(formatYaml(node.children, indent + '  '));
			}
		} else {
			lines.push(`${indent}- id: ${node.id}`);
			lines.push(`${indent}  title: ${node.title}`);
			lines.push(`${indent}  status: ${node.status}`);
			if (node.details) lines.push(`${indent}  details: ${node.details}`);
			if (node.priority) lines.push(`${indent}  priority: ${node.priority}`);
			if (node.due_date) lines.push(`${indent}  due: ${node.due_date}`);
		}
	}
	return lines.join('\n');
}

export function formatTaskYaml(tree: TreeNode[]): string {
	return formatYaml(tree);
}

export class TaskTool extends ToolBase {
	name = 'task';
	description = 'Manage tasks and groups. Groups are containers (create_group, delete_group). Tasks are actionable work (create, update, complete, delete). list shows all. States: pending → active → done. Paused tasks don\'t trigger continuation. All pending/active tasks will keep notifying the agent to continue work until done or paused.';
	input_schema = {
		type: 'object',
		properties: {
			action: { type: 'string', enum: ['create_group', 'delete_group', 'create', 'update', 'complete', 'delete', 'list'], description: 'Action to perform' },
			id: { type: 'number', description: 'ID (required for update/complete/delete/delete_group)' },
			title: { type: 'string', description: 'Title (required for create/create_group)' },
			details: { type: 'string', description: 'Detailed description' },
			group_id: { type: 'number', description: 'Parent group ID' },
			parent_id: { type: 'number', description: 'Parent group ID (for create_group nesting)' },
			priority: { type: 'number', description: 'Global priority (lower = higher, default 0)' },
			due_date: { type: 'string', description: 'Due date (ISO 8601)' },
			status: { type: 'string', enum: ['pending', 'active', 'paused', 'done'], description: 'Task status (for update)' },
		},
		required: ['action'],
	};

	private manager: TaskManager;
	constructor(manager: TaskManager) { super(); this.manager = manager; }

	async call(input: Record<string, any>): Promise<ToolResult> {
		try {
			switch (input.action) {
				case 'create_group': {
					if (!input.title) return { content: 'Error: title is required', isError: true };
					const id = this.manager.createGroup(input.title, input.parent_id);
					return { content: `Created group g${id}: ${input.title}`, isError: false };
				}
				case 'delete_group': {
					if (!input.id) return { content: 'Error: id is required', isError: true };
					const ok = this.manager.deleteGroup(input.id);
					if (!ok) return { content: `Group g${input.id} not found`, isError: true };
					return { content: `Deleted group g${input.id}`, isError: false };
				}
				case 'create': {
					if (!input.title) return { content: 'Error: title is required', isError: true };
					const id = this.manager.createTask(input.title, input.details, input.group_id, input.priority, input.due_date);
					return { content: `Created task #${id}: ${input.title}`, isError: false };
				}
				case 'update': {
					if (!input.id) return { content: 'Error: id is required', isError: true };
					const fields: any = {};
					for (const key of ['title', 'details', 'status', 'priority', 'group_id', 'due_date']) {
						if (input[key] !== undefined) fields[key] = input[key];
					}
					const ok = this.manager.updateTask(input.id, fields);
					if (!ok) return { content: `Task #${input.id} not found`, isError: true };
					return { content: `Updated task #${input.id}`, isError: false };
				}
				case 'complete': {
					if (!input.id) return { content: 'Error: id is required', isError: true };
					const ok = this.manager.completeTask(input.id);
					if (!ok) return { content: `Task #${input.id} not found`, isError: true };
					return { content: `Completed task #${input.id}`, isError: false };
				}
				case 'delete': {
					if (!input.id) return { content: 'Error: id is required', isError: true };
					const ok = this.manager.deleteTask(input.id);
					if (!ok) return { content: `Task #${input.id} not found`, isError: true };
					return { content: `Deleted task #${input.id}`, isError: false };
				}
				case 'list': {
					const tree = this.manager.tree();
					if (!tree.length) return { content: 'No tasks', isError: false };
					return { content: formatTree(tree), isError: false };
				}
				default:
					return { content: `Unknown action: ${input.action}`, isError: true };
			}
		} catch (e: any) {
			return { content: e.message, isError: true };
		}
	}
}
