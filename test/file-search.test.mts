import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { FileSearchTool } from '../tool-file-search.mts';

const tool = new FileSearchTool();
const tmp = join(import.meta.dirname, '.tmp-file-search');

beforeAll(() => {
	mkdirSync(join(tmp, 'src'), { recursive: true });
	mkdirSync(join(tmp, 'node_modules/dep'), { recursive: true });
	mkdirSync(join(tmp, '.git'), { recursive: true });
	mkdirSync(join(tmp, 'data/images'), { recursive: true });
	writeFileSync(join(tmp, 'readme.md'), 'hello world');
	writeFileSync(join(tmp, 'src/index.ts'), 'console.log("hi")');
	writeFileSync(join(tmp, 'node_modules/dep/index.js'), 'module.exports = {}');
	writeFileSync(join(tmp, '.git/HEAD'), 'ref: refs/heads/main');
	for (let i = 0; i < 60; i++) writeFileSync(join(tmp, `data/images/img-${i}.jpg`), '');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('file_search', () => {
	describe('tree', () => {
		it('shows files and directories', async () => {
			const r = await tool.call({ command: 'tree', path: tmp });
			expect(r.isError).toBe(false);
			expect(r.content).toContain('readme.md');
			expect(r.content).toContain('src/');
		});

		it('auto-excludes node_modules and .git', async () => {
			const r = await tool.call({ command: 'tree', path: tmp });
			expect(r.content).toContain('node_modules/  (excluded)');
			expect(r.content).toContain('.git/  (excluded)');
			expect(r.content).not.toContain('dep/');
			expect(r.content).not.toContain('HEAD');
		});

		it('accepts extra excludes via args', async () => {
			const r = await tool.call({ command: 'tree', path: tmp, args: ['data'] });
			expect(r.content).toContain('data/  (excluded)');
			expect(r.content).not.toContain('img-');
		});

		it('caps entries per directory', async () => {
			const r = await tool.call({ command: 'tree', path: tmp });
			expect(r.content).toContain('... +');
		});

		it('shows absolute path as root', async () => {
			const r = await tool.call({ command: 'tree', path: tmp });
			expect(r.content.split('\n')[0]).toBe(tmp);
		});
	});

	describe('shell commands', () => {
		it('runs ls with path', async () => {
			const r = await tool.call({ command: 'ls', args: ['-la'], path: tmp });
			expect(r.isError).toBe(false);
			expect(r.content).toContain('readme.md');
		});

		it('runs grep', async () => {
			const r = await tool.call({ command: 'grep', args: ['-r', 'hello', tmp] });
			expect(r.isError).toBe(false);
			expect(r.content).toContain('hello world');
		});

		it('rejects unknown commands', async () => {
			const r = await tool.call({ command: 'rm' as any, args: ['-rf', '/'] });
			expect(r.isError).toBe(true);
			expect(r.content).toContain('Unknown command');
		});
	});
});
