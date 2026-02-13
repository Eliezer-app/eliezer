# Widgets

Widgets are interactive HTML/JS components embedded in chat messages via iframes.

## Embedding Widgets

Create `/opt/clawchat/apps/<my-app>/public/index.html`, then embed in a message using an iframe.

Where `<my-app>` is the unique APP_ID: `/^[\w-]+$/`, so \w, \d, -, _ 

Example message:

Here is a nice Earth animation:

<iframe src="/widget/earth/"></iframe>

## Static server

The server serves static files from `/opt/clawchat/apps/<my-app>/public/` at `/widget/<my-app>/`.

## API

State is scoped by app ID (same as <my-app> above). No initialization needed.

`GET /api/app-state/<app-id>` — Returns `{ state: {...}, version: N }`.

`POST /api/app-state/<app-id>` — JSON body: `{ state: {...} }`. Widgets with the same app ID share state and sync across instances via SSE.

`POST /api/widget-log/<app-id>` — JSON body is written as-is to `/opt/clawchat/apps/<app-id>/logs/<yyyy-mm-dd>.log`.

## Auto Features

- **Resize** — Parent-side ResizeObserver auto-sizes the iframe to fit content (file-based only)
- **Injected CSS** — `html, body { height: auto; min-height: 0; overflow: hidden; }` prevents scrollbars and viewport unit issues
- **Sandbox** — File-based: none (same-origin, full trust). Data URL: `allow-scripts` only
- **Lazy loading** — Widgets are created when within 500px of the viewport and destroyed when scrolled away

## Example: Counter (data URL, no state)

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui; padding: 16px; display: flex; gap: 16px; align-items: center; color: white; }
    button { padding: 8px 16px; font-size: 16px; }
    span { font-size: 24px; min-width: 40px; text-align: center; }
  </style>
</head>
<body>
  <button onclick="count--; update()">-</button>
  <span id="v">0</span>
  <button onclick="count++; update()">+</button>
  <script>
    let count = 0;
    const update = () => document.getElementById('v').textContent = count;
  </script>
</body>
</html>
```

Base64-encode and embed as <iframe src="data:text/html;base64,...">.

## Example: File-based Widget with State

`/opt/clawchat/apps/todo/public/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui; padding: 16px; }
    input { padding: 8px; margin-right: 8px; }
    button { padding: 8px 16px; }
    ul { list-style: none; padding: 0; margin-top: 12px; }
    li { padding: 8px; background: #f5f5f5; margin: 4px 0; border-radius: 4px; }
  </style>
</head>
<body>
  <input id="inp" placeholder="Add task..." />
  <button onclick="add()">Add</button>
  <ul id="list"></ul>
  <script>
    const APP_ID = 'todo';
    let tasks = [];
    // only enable logging when debugging, to keep chattiness low
    const logEnabled = false;

    async function apiDo(method, url, body) {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return res.json();
    }

    async function log(...args) {
      if (!logEnabled) return
      return apiDo('POST', `/api/widget-log/${APP_ID}`, args.length === 1 ? args[0] : args).catch(() => {});
    }

    async function loadState() {
      try {
        const data = await apiDo('GET', `/api/app-state/${APP_ID}`);
        tasks = data.state?.tasks || [];
        // to prevent logging coming out of order, wait for it
        await log('loaded', tasks.length, 'tasks');
        render();
      } catch (e) { log('loadState error', e.message); }
    }

    function saveState() {
      apiDo('POST', `/api/app-state/${APP_ID}`, { state: { tasks } });
    }

    function render() {
      document.getElementById('list').innerHTML =
        tasks.map(t => `<li>${t}</li>`).join('');
    }

    function add() {
      const inp = document.getElementById('inp');
      if (inp.value.trim()) {
        tasks.push(inp.value.trim());
        inp.value = '';
        render();
        saveState();
      }
    }

    loadState();
  </script>
</body>
</html>
```

Embed: <iframe src="/widget/todo/"></iframe>

## Fullscreen

The ⧉ button on widget messages opens the widget in a new browser tab.

## Server-side Endpoints

Widgets can have custom server-side routes. Create `apps/<my-app>/index.mts` exporting a default function that receives an Express Router:

```typescript
import { Router } from 'express';

export default (router: Router) => {
  router.get('/weather', async (req, res) => {
    const { lat, lon } = req.query;
    // ... fetch from external API, query DB, etc.
    res.json({ temp: 22, description: 'Clear' });
  });
};
```

Routes are mounted at `/widget/<my-app>/api/`. Widget calls `fetch('/widget/myapp/api/weather?lat=...')`.


### clawchat-widgets service
Widget handlers are served by a different service.
After making changes to `apps/<my-app>/index.mts`, restart clawchat-widgets service:
`systemctl restart clawchat-widgets`
And check logs:                                                                                                              
`journalctl -u clawchat-widgets -f`



For a complete example with server-side weather API, see `apps/example/`.

## File Structure

```
apps/
  mywidget/
    public/
      index.html    # Entry point, served at /widget/mywidget/
      style.css     # Optional additional files
      ...
    index.mts       # Optional server-side routes, mounted at /widget/mywidget/api/
    logs/
      2026-01-01.log
```
