import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskManager, TaskTool, formatTaskTree } from '../tasks.mts';

function createDb(): Database.Database {
	return new Database(':memory:');
}

describe('TaskManager', () => {
	let db: Database.Database;
	let mgr: TaskManager;

	beforeEach(() => {
		db = createDb();
		mgr = new TaskManager(db);
	});

	describe('groups', () => {
		it('creates a group and returns id', () => {
			const id = mgr.createGroup('Project');
			expect(id).toBe(1);
		});

		it('nests groups', () => {
			const parent = mgr.createGroup('Parent');
			const child = mgr.createGroup('Child', parent);
			const { groups } = mgr.listAll();
			expect(groups).toHaveLength(2);
			expect(groups.find(g => g.id === child)!.parent_id).toBe(parent);
		});

		it('delete cascades to child groups and tasks', () => {
			const parent = mgr.createGroup('Parent');
			const child = mgr.createGroup('Child', parent);
			mgr.createTask('Task in child', '', child);
			mgr.createTask('Task in parent', '', parent);
			mgr.deleteGroup(parent);
			const { groups, tasks } = mgr.listAll();
			expect(groups).toHaveLength(0);
			expect(tasks).toHaveLength(0);
		});

		it('returns false for nonexistent group', () => {
			expect(mgr.deleteGroup(999)).toBe(false);
		});
	});

	describe('tasks', () => {
		it('creates a task with defaults', () => {
			const id = mgr.createTask('Buy groceries');
			expect(id).toBe(1);
			const { tasks } = mgr.listAll();
			expect(tasks[0].title).toBe('Buy groceries');
			expect(tasks[0].status).toBe('pending');
			expect(tasks[0].priority).toBe(0);
		});

		it('creates with all fields', () => {
			const gid = mgr.createGroup('Work');
			mgr.createTask('Deploy', 'Push to prod', gid, 1, '2026-03-01');
			const { tasks } = mgr.listAll();
			expect(tasks[0].details).toBe('Push to prod');
			expect(tasks[0].group_id).toBe(gid);
			expect(tasks[0].priority).toBe(1);
			expect(tasks[0].due_date).toBe('2026-03-01');
		});

		it('updates fields', () => {
			const id = mgr.createTask('Old');
			mgr.updateTask(id, { title: 'New', status: 'active' });
			const { tasks } = mgr.listAll();
			expect(tasks[0].title).toBe('New');
			expect(tasks[0].status).toBe('active');
		});

		it('update returns false for nonexistent', () => {
			expect(mgr.updateTask(999, { title: 'Nope' })).toBe(false);
		});

		it('completes a task', () => {
			const id = mgr.createTask('Task');
			expect(mgr.completeTask(id)).toBe(true);
			const { tasks } = mgr.listAll();
			expect(tasks[0].status).toBe('done');
		});

		it('complete returns false for nonexistent', () => {
			expect(mgr.completeTask(999)).toBe(false);
		});

		it('deletes a task', () => {
			const id = mgr.createTask('Task');
			expect(mgr.deleteTask(id)).toBe(true);
			expect(mgr.listAll().tasks).toHaveLength(0);
		});

		it('delete returns false for nonexistent', () => {
			expect(mgr.deleteTask(999)).toBe(false);
		});
	});

	describe('pending', () => {
		it('returns pending and active tasks', () => {
			mgr.createTask('Pending');
			const id2 = mgr.createTask('Working');
			const id3 = mgr.createTask('Done');
			mgr.updateTask(id2, { status: 'active' });
			mgr.completeTask(id3);
			expect(mgr.pending()).toHaveLength(2);
		});

		it('orders by global priority', () => {
			mgr.createTask('Low', '', undefined, 10);
			mgr.createTask('High', '', undefined, 1);
			const pending = mgr.pending();
			expect(pending[0].title).toBe('High');
			expect(pending[1].title).toBe('Low');
		});
	});

	describe('tree', () => {
		it('builds merged tree', () => {
			const gid = mgr.createGroup('Project');
			mgr.createTask('Root task');
			mgr.createTask('Grouped task', '', gid);
			const tree = mgr.tree();
			expect(tree).toHaveLength(2);
			const group = tree.find(n => n.kind === 'group')!;
			expect(group.title).toBe('Project');
			expect(group.children).toHaveLength(1);
			expect(group.children[0].title).toBe('Grouped task');
			const root = tree.find(n => n.kind === 'task')!;
			expect(root.title).toBe('Root task');
		});

		it('nests groups in groups', () => {
			const parent = mgr.createGroup('Parent');
			const child = mgr.createGroup('Child', parent);
			mgr.createTask('Leaf', '', child);
			const tree = mgr.tree();
			expect(tree).toHaveLength(1);
			expect(tree[0].children).toHaveLength(1);
			expect(tree[0].children[0].children).toHaveLength(1);
			expect(tree[0].children[0].children[0].title).toBe('Leaf');
		});
	});
});

describe('formatTaskTree', () => {
	let db: Database.Database;
	let mgr: TaskManager;

	beforeEach(() => {
		db = createDb();
		mgr = new TaskManager(db);
	});

	it('formats groups and tasks', () => {
		const gid = mgr.createGroup('Project');
		mgr.createTask('Task A', '', gid);
		mgr.createTask('Task B');
		const output = formatTaskTree(mgr.tree());
		expect(output).toContain('▸ [g1] Project');
		expect(output).toContain('  [pending] #1 Task A');
		expect(output).toContain('[pending] #2 Task B');
	});

	it('shows task status and due date', () => {
		const id = mgr.createTask('Urgent', '', undefined, 0, '2026-03-01');
		mgr.updateTask(id, { status: 'active' });
		const output = formatTaskTree(mgr.tree());
		expect(output).toContain('[active] #1 Urgent (due: 2026-03-01)');
	});
});

describe('TaskTool', () => {
	let db: Database.Database;
	let tool: TaskTool;

	beforeEach(() => {
		db = createDb();
		const manager = new TaskManager(db);
		tool = new TaskTool(manager);
	});

	it('creates a group', async () => {
		const result = await tool.call({ action: 'create_group', title: 'Project' });
		expect(result.isError).toBe(false);
		expect(result.content).toContain('g1');
	});

	it('deletes a group', async () => {
		await tool.call({ action: 'create_group', title: 'Project' });
		const result = await tool.call({ action: 'delete_group', id: 1 });
		expect(result.isError).toBe(false);
	});

	it('creates a task', async () => {
		const result = await tool.call({ action: 'create', title: 'Do stuff' });
		expect(result.isError).toBe(false);
		expect(result.content).toContain('#1');
	});

	it('completes a task', async () => {
		await tool.call({ action: 'create', title: 'Task' });
		const result = await tool.call({ action: 'complete', id: 1 });
		expect(result.isError).toBe(false);
	});

	it('lists tasks and groups', async () => {
		await tool.call({ action: 'create_group', title: 'Group' });
		await tool.call({ action: 'create', title: 'Task', group_id: 1 });
		const result = await tool.call({ action: 'list' });
		expect(result.content).toContain('▸ [g1] Group');
		expect(result.content).toContain('[pending] #1 Task');
	});

	it('returns error for unknown action', async () => {
		const result = await tool.call({ action: 'explode' });
		expect(result.isError).toBe(true);
	});

	it('requires title for create', async () => {
		const result = await tool.call({ action: 'create' });
		expect(result.isError).toBe(true);
	});

	it('requires title for create_group', async () => {
		const result = await tool.call({ action: 'create_group' });
		expect(result.isError).toBe(true);
	});
});
