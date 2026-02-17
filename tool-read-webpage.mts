import { ToolBase, ToolResult } from './tools.mts';

export class ReadWebpageTool extends ToolBase {
	name = 'read_webpage';
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
		// Dynamic import to avoid loading puppeteer unless needed
		const puppeteer = await import('puppeteer');
		let browser;
		
		try {
			browser = await puppeteer.launch({
				headless: 'new',
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--single-process'
				]
			});

			const page = await browser.newPage();
			
			// Set viewport
			await page.setViewport({ width: 1280, height: 800 });
			
			// Navigate with timeout
			await page.goto(url, { 
				waitUntil: 'networkidle0',
				timeout: timeout ?? 30000
			});

			// Wait for specific element if requested
			if (wait_for) {
				await page.waitForSelector(wait_for, { timeout: timeout ?? 30000 });
			}

			// Check for abort signal
			if (signal?.aborted) {
				await browser.close();
				return { content: 'aborted', isError: true };
			}

			// Extract content
			const content = await page.evaluate((sel) => {
				const element = document.querySelector(sel || 'body');
				if (!element) return '';
				// Get text content but preserve some structure
				return element.innerText || element.textContent || '';
			}, selector);

			await browser.close();
			
			if (!content || content.trim().length === 0) {
				return { content: 'No content found at the specified selector', isError: false };
			}

			// Limit output size
			const maxLength = 50000;
			const truncated = content.length > maxLength 
				? content.slice(0, maxLength) + '\n\n[Content truncated - ' + (content.length - maxLength) + ' characters remaining]'
				: content;

			return { content: truncated, isError: false };

		} catch (e: any) {
			if (browser) await browser.close();
			return { content: `Error reading webpage: ${e.message}`, isError: true };
		}
	}
}
