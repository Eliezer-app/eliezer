# Plan: Read Page Tool (Playwright)

## Current state

A quick prototype (`tool-read-webpage.mts`) is deployed using Puppeteer. It works but is missing vetting, fencing, shared browser instance, and uses Puppeteer instead of Playwright. Good enough to get us going — this plan covers the hardened version.

## Problem

The agent can search the web (web_search → snippets) and download files (wget_tool), but can't read rendered web pages. Modern sites are SPAs with JS-rendered content — raw HTML from wget is often useless. The agent needs to read a URL and get clean text.

## Design

New tool: `read_page`. Takes a URL, renders it with headless Chromium via Playwright, extracts visible text, vets it, returns it.

```
read_page({ url: "https://docs.example.com/api" })
→ vetted, truncated page text
```

Separate from wget_tool — wget downloads files, read_page reads pages.

## Architecture

```
Agent → read_page tool → Playwright (headless Chromium)
                              │
                         page.innerText()
                              │
                         vetContent() ← existing vetting LLM
                              │
                         fenced text → Agent
```

### Browser lifecycle

Single shared browser instance, created on first call, reused across all subsequent calls. One `BrowserContext` per call (isolated cookies/state), closed after extraction.

```typescript
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browser) browser = await chromium.launch();
    return browser;
}
```

No pool, no complexity. Chromium process stays warm. Context-per-call gives isolation without launch overhead.

### Text extraction

```typescript
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
const text = await page.innerText('body');
await context.close();
```

`innerText('body')` gives rendered visible text — no HTML tags, no hidden elements, no script content. Good enough for most pages.

### Truncation and vetting

- Cap at 100k chars (configurable). Pages beyond that are pathological.
- Vet through existing `vetContent(llm, text, source)` — same as wget_tool.
- Fence with nonce delimiters — same as web_search.
- Return fenced text to agent.

### Tool definition

```typescript
class ReadPageTool extends ToolBase {
    name = 'read_page';
    description = 'Read a web page and return its visible text content. Uses a real browser (handles JS-rendered pages). Content is security-vetted. For downloading files, use wget_tool instead.';
    input_schema = {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'URL to read' },
        },
        required: ['url'],
    };
}
```

## Container setup

Playwright needs Chromium binaries. Two options:

**Option A: Install in node image (simpler)**
Add to docker-compose init or a custom Dockerfile:
```dockerfile
FROM node:22-slim
RUN npx playwright install --with-deps chromium
```
~300MB added to image. Straightforward.

**Option B: Use playwright image**
```yaml
image: mcr.microsoft.com/playwright:v1.50.0-noble
```
Larger base image but guaranteed compatibility.

Option A is better — keeps the existing node:22-slim base, just adds Chromium.

### docker-compose.yml changes

Update init service to install Chromium deps:
```yaml
init:
    image: node:22-slim
    working_dir: /opt/eliezer
    volumes:
      - .:/opt/eliezer
      - node_modules:/opt/eliezer/node_modules
    command: sh -c 'npm ci && npx playwright install --with-deps chromium'
```

Playwright is already in package.json (added by agent).

## Files to modify

### New: `read-page.mts`
- `ReadPageTool` class extending `ToolBase`
- Shared browser instance (`getBrowser()`)
- `call()`: launch context → navigate → extract text → close context → vet → fence → return
- Error handling: timeout, navigation failure, empty page

### `eliezer.mts`
- Import `ReadPageTool`
- Add to tools array: `new ReadPageTool(compactionLlm)`

### `docker-compose.yml`
- Update init command to install Chromium

### `test/read-page.test.mts`
- Unit test with a local HTTP server serving a simple HTML page
- Verify text extraction, truncation, vetting integration

## Edge cases

- **Timeout**: 30s navigation timeout. Return error, don't hang.
- **Downloads triggered by URL**: Playwright can intercept — abort any download requests.
- **Infinite scroll / heavy pages**: `networkidle` + timeout handles this. Don't try to be clever.
- **PDF URLs**: Playwright can't render these well. Detect and suggest wget_tool.
- **Browser crash**: Set `browser = null`, next call relaunches.

## Not in scope

- Screenshots / visual analysis
- Form filling / interaction
- Cookie persistence across calls
- JavaScript execution (beyond page load)

## TODO

- [ ] Create `read-page.mts` with `ReadPageTool` class
- [ ] Shared browser instance lifecycle (`getBrowser()`)
- [ ] Text extraction via `page.innerText('body')`
- [ ] Truncation (100k chars cap)
- [ ] Vet through `vetContent()`
- [ ] Fence output with nonce delimiters
- [ ] Wire into `eliezer.mts` tools array
- [ ] Update `docker-compose.yml` init to install Chromium
- [ ] Timeout + error handling (30s, navigation failures, crashes)
- [ ] Abort download requests interceptor
- [ ] Tests: `test/read-page.test.mts`
