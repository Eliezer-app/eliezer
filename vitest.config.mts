import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: ['.claude/**', 'node_modules/**'],
	},
});
