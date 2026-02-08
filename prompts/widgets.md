# Widgets and Apps

You can create anything from a simple html widget to complex, full-feature, stateful and active applications.
Follow the filesystem and framework structure described here to keep things clean.

Start with picking name for your application.
Place applications in `/opt/clawchat/apps/<app-name>`.
Place ALL widgets in the correct path: `/opt/clawchat/apps/myapp/mywidget.html`.
Any other path will not work. Widgets are not images, but they can reference images from `/opt/eliezer/chat-public/`.

Widgets are interactive HTML/JS components embedded in chat messages.
Widgets can be stateful if needed. Simple state persistence is provided by the framework.


## Inline Widget

Send HTML inside a ```widget``` code block:

    ```widget
    <html>...</html>
    ```

## File-based Widget

Write an HTML file to `/opt/clawchat/apps/<app-name>/widget1.html`,
(example: `/opt/clawchat/apps/myapp/widget1.html`) then reference it:

    ```widget:myapp/widget1.html
    ```

Path traversal (`..`) is blocked.

## Framework API

A framework is auto-injected into every widget. Use `widget.*` methods:

- `widget.onState(callback)` — receive state updates
- `widget.getState(appId)` — request current state (call after onState)
- `widget.setState(appId, state)` — persist state to server
- `widget.request(appId, action, payload)` — call a server-side action (returns promise)

Widgets with the same `appId` share state and sync live.

## Example

```widget
<!DOCTYPE html>
<html>
<head><style>body { font-family: system-ui; padding: 16px; }</style></head>
<body>
  <input id="inp" placeholder="Add task..." />
  <button onclick="add()">Add</button>
  <ul id="list"></ul>
  <script>
    const APP_ID = 'todo';
    let tasks = [];
    function render() {
      document.getElementById('list').innerHTML = tasks.map(t => `<li>${t}</li>`).join('');
    }
    function add() {
      const inp = document.getElementById('inp');
      if (inp.value.trim()) { tasks.push(inp.value.trim()); inp.value = ''; render(); widget.setState(APP_ID, { tasks }); }
    }
    widget.onState(state => { tasks = state?.tasks || []; render(); });
    widget.getState(APP_ID);
  </script>
</body>
</html>
```

## Fullscreen

Widgets have a fullscreen button (opens in new tab). Detect with:

```css
body.widget-fullscreen { height: 100%; }
```

Note: curl/wget are not installed — use the wget tool to download files!

## Widget Debugging

Use `widget.log(...)` to write to server-side log files. Acts similar to console.log().
Logs are written to apps/<app-name>/<widget-name>/logs/<YYYY-MM-DD>.log.
Only works for file-based widgets (widget:path/file.html), not inline widgets. Example:                                      
  widget.log("initialized", { count: items.length });
  widget.log("click", event.target.id);
