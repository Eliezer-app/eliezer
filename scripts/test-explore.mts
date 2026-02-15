import { config } from 'dotenv';
config();

import { createLLM } from '../llm.mts';
import { CodebaseExplorerTool } from '../tool-explore.mts';

const llm = createLLM({
	provider: process.env.LLM_PROVIDER!,
	apiKey: process.env.LLM_API_KEY!,
	model: process.env.LLM_MODEL!,
	baseUrl: process.env.LLM_BASE_URL!,
});

const log: string[] = [];

const origCall = llm.call.bind(llm);
let turn = 0;
llm.call = async (...args: Parameters<typeof origCall>) => {
	turn++;
	const msgs = args[0];
	const last = msgs[msgs.length - 1];
	if (last.role === 'user' && Array.isArray(last.content)) {
		for (const block of last.content) {
			if ((block as any).type === 'tool_result') {
				const b = block as any;
				const preview = b.content?.slice(0, 300) || '';
				log.push(`  ← ${b.tool_use_id}: ${preview}${b.content?.length > 300 ? '...' : ''}`);
			}
		}
	}
	log.push(`\n--- Turn ${turn} (${msgs.length} messages) ---`);
	const response = await origCall(...args);
	for (const block of response.content) {
		if (block.type === 'text') log.push(`  [text] ${block.text.slice(0, 200)}${block.text.length > 200 ? '...' : ''}`);
		if (block.type === 'tool_use') log.push(`  → ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
	}
	return response;
};

const explorer = new CodebaseExplorerTool(llm);

const t0 = Date.now();
const result = await explorer.call({
	path: '/home/projects/petitecoco-custom',
	question: 'Explore the payment system in detail.',
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log('=== ACTIONS LOG ===\n');
console.log(log.join('\n'));
console.log(`\n\n=== AGENT OUTPUT (${elapsed}s, error=${result.isError}) ===\n`);
console.log(result.content);
