import { resolve } from 'path';
import { ToolBase, ToolResult } from './tools.mts';

const useSystemChrome = !!process.env.PUPPETEER_EXECUTABLE_PATH;

export class ReadWebpageTool extends ToolBase {
	name = 'read_webpage';
	defaultTimeout = 60;
	description = 'Read a webpage using headless Chrome (Puppeteer). Returns the rendered text content. Use for JavaScript-heavy sites that wget_tool cannot handle. Slower but more accurate rendering.';
	input_schema = {
		type: 'object',
		properties: {
			url: { type: 'string', description: 'URL to read' },
			selector: { type: 'string', description: 'Optional CSS selector to extract specific content (default: body)' },
			wait_for: { type: 'string', description: 'Optional selector to wait for before extracting (for dynamic content)' },
			timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
		},
		required: ['url'],
	};

	async call({ url, selector, wait_for, timeout }: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
		const puppeteer = await import('puppeteer');
		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

		const onAbort = () => { browser?.close().catch(() => {}); };
		signal?.addEventListener('abort', onAbort, { once: true });

		try {
			const launchOpts: any = useSystemChrome
				? {
					headless: true,
					args: ['--user-data-dir=' + resolve('state/chrome-profile')],
				}
				: {
					headless: true,
					args: [
						'--no-sandbox',
						'--disable-setuid-sandbox',
						'--disable-dev-shm-usage',
						'--disable-gpu',
						'--single-process',
					],
				};
			browser = await puppeteer.launch(launchOpts);

			const page = await browser.newPage();
			await page.setViewport({ width: 1280, height: 800 });

			await page.goto(url, {
				waitUntil: 'networkidle0',
				timeout: timeout ?? 30000
			});

			if (wait_for) {
				await page.waitForSelector(wait_for, { timeout: timeout ?? 30000 });
			}

			if (signal?.aborted) return { content: 'aborted', isError: true };

			const content = await page.evaluate((sel) => {
				const element = document.querySelector(sel || 'body');
				if (!element) return '';
				return element.innerText || element.textContent || '';
			}, selector);

			await browser.close();
			browser = undefined;

			if (!content || content.trim().length === 0) {
				return { content: 'No content found at the specified selector', isError: false };
			}

			const maxLength = 50000;
			const truncated = content.length > maxLength
				? content.slice(0, maxLength) + '\n\n[Content truncated - ' + (content.length - maxLength) + ' characters remaining]'
				: content;

			return { content: truncated, isError: false };

		} catch (e: any) {
			if (browser) await browser.close().catch(() => {});
			if (signal?.aborted) return { content: 'aborted', isError: true };
			return { content: `Error reading webpage: ${e.message}`, isError: true };
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
	}
}
