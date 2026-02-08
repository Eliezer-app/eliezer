# Widgets

Widgets are interactive HTML/JS components embedded in chat messages.

## Inline Widget

Send HTML inside a ```widget``` code block:

    ```widget
    <html>...</html>
    ```

## File-based Widget

Write an HTML file to `/opt/clawchat/apps/`, then reference it:

    ```widget:myapp/index.html
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
