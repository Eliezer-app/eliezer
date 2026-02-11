# Plan: Approval Gate

## Problem

Some actions are too risky for the agent to take autonomously but shouldn't be permanently blocked. Examples:
- Downloading unvettable files (binary, large)
- Installing packages from untrusted sources
- Modifying system configuration
- Any future action we want human oversight on

The agent LLM cannot be trusted to enforce a "ask then retry" protocol. The gate must be deterministic infrastructure.

## Design

### Core abstraction

```typescript
interface ApprovalRequest {
  id: string;            // uuid
  action: string;        // e.g. 'download', 'install', 'config_change'
  description: string;   // human-readable: "Download northwind.db (24MB) from github.com"
  domain?: string;       // grouping key for whitelisting (e.g. 'github.com/jpwhite3')
  status: 'pending' | 'approved' | 'denied';
  created_at: number;
  resolved_at?: number;
}
```

### SQLite tables

```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE approval_whitelist (
  action TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (action, domain)
);
```

Whitelist is scoped by action — whitelisting `github.com/jpwhite3` for `download` doesn't whitelist it for `install`.

### API: `ApprovalGate`

```typescript
class ApprovalGate {
  constructor(db: Database, notify: (req: ApprovalRequest) => void);

  // Tool calls this. Returns immediately.
  // - whitelisted → { status: 'approved' }
  // - existing approved/denied → returns that
  // - new → inserts pending, calls notify(), returns { status: 'pending' }
  async check(action: string, description: string, domain?: string): Promise<ApprovalRequest>;

  // Chat calls this when user responds.
  async resolve(id: string, status: 'approved' | 'denied', whitelistDomain?: boolean): void;

  // Check if domain is whitelisted for action.
  isWhitelisted(action: string, domain: string): boolean;
}
```

### Flow

```
Tool                     ApprovalGate              Chat
 │                           │                       │
 ├── check('download',      │                       │
 │   'northwind.db 24MB',   │                       │
 │   'github.com/jpwhite3') │                       │
 │                           │                       │
 │   not whitelisted         │                       │
 │   no existing request     │                       │
 │                           ├── INSERT pending ──►  │
 │                           ├── notify() ─────────► │ render approval prompt
 │  ◄── { status: 'pending' }│                       │
 │                           │                       │
 │  return to agent:         │                       │
 │  "Awaiting approval"      │                       │
 │                           │                       │
 │                           │    user clicks ◄──────┤
 │                           │◄── resolve(id,        │
 │                           │    'approved', true)   │
 │                           │                       │
 │  agent retries            │                       │
 ├── check() ──────────────► │                       │
 │  ◄── { status: 'approved'}│                       │
 │                           │                       │
 │  proceed with action      │                       │
```

### `notify` callback

The `notify` function sends a structured message to clawchat. Not a regular chat message — a typed event that clawchat renders as an interactive prompt.

```typescript
// Message sent to chat
{
  type: 'approval_request',
  id: 'uuid',
  action: 'download',
  description: 'Download northwind.db (24MB) from github.com/jpwhite3',
  domain: 'github.com/jpwhite3',
  options: [
    { label: 'Allow', value: 'approved' },
    { label: 'Allow + trust github.com/jpwhite3 for downloads', value: 'approved+whitelist' },
    { label: 'Deny', value: 'denied' },
  ]
}
```

### Clawchat side

Clawchat needs to:
1. Recognize `approval_request` message type
2. Render as interactive buttons (not plain text)
3. On user click, POST back to eliezer: `POST /approval/:id { status, whitelist? }`
4. Or: write directly to SQLite if clawchat has DB access

### Domain heuristics

Extract a meaningful grouping key from URLs:
- `raw.githubusercontent.com/jpwhite3/northwind-SQLite3/...` → `github.com/jpwhite3`
- `registry.npmjs.org/@scope/pkg` → `npmjs.org/@scope`
- `registry.npmjs.org/pkg` → `npmjs.org/pkg`
- `cdn.example.com/path/file` → `example.com`

```typescript
function extractDomain(url: string): string;
```

### Integration with wgetTool

```typescript
// In wgetTool, when file can't be auto-vetted:
const approval = await gate.check('download', `${filename} (${sizeKB}KB) from ${domain}`, domain);
if (approval.status === 'pending') {
  return { content: `Awaiting user approval to download ${filename} from ${domain}.`, isError: true };
}
if (approval.status === 'denied') {
  return { content: `Download denied by user.`, isError: true };
}
// approved — proceed with download
```

### Expiry

Pending requests older than 24h are auto-denied on next check. Prevents stale approvals from accumulating.

Whitelist entries don't expire — user explicitly trusted the domain.

## Files

- `approval.mts` — **new**: `ApprovalGate` class, `extractDomain()`, DB schema
- `tools.mts` — integrate gate into wgetTool (and future tools)
- `eliezer.mts` — create gate, pass to tools, wire notify to chat
- `test/approval.test.mts` — **new**: gate logic, whitelist, expiry
- Clawchat changes (separate repo/scope):
  - Approval request message rendering
  - User response handler
  - API endpoint or DB write for resolution

## TODO

- [ ] `ApprovalGate` class with check/resolve/isWhitelisted
- [ ] `extractDomain()` heuristic
- [ ] SQLite tables (approval_requests, approval_whitelist)
- [ ] Integrate into wgetTool
- [ ] `notify` callback wired to chat
- [ ] Pending request expiry (24h)
- [ ] Unit tests
- [ ] Clawchat: approval UI (separate scope)
