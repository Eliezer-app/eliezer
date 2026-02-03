#!/bin/bash
set -e

PROMPT_FILE="seed-prompt.txt"
OUTPUT="mount/seed.sh"

cat > "$OUTPUT" << 'SCRIPT_EOF'
#!/bin/bash
: <<'PROMPT'
SCRIPT_EOF

# Insert prompt as-is
cat "$PROMPT_FILE" >> "$OUTPUT"

cat >> "$OUTPUT" << 'SCRIPT_EOF'
PROMPT
set -e

# load credentials
set -a
. /opt/eliezer/credentials.env
set +a

# minimal bootstrap
mkdir -p /var/log/eliezer /var/run/eliezer
DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm sqlite3 cron curl >/dev/null
service cron start

# install tsx for running TypeScript
cd /opt/eliezer
npm init -y >/dev/null 2>&1
npm install --silent tsx >/dev/null 2>&1

# write bootstrap script
cat > /tmp/bootstrap.mjs << 'BOOTSTRAP'
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-4-5-20250514';

const seedScript = readFileSync('/opt/eliezer/seed.sh', 'utf-8');

const prefill = "import { execSync } from 'child_process';\nimport { writeFileSync, readFileSync, existsSync } from 'fs';";

const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': ANTHROPIC_API_KEY,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 8192,
    messages: [
      { role: 'user', content: seedScript },
      { role: 'assistant', content: prefill }
    ]
  })
});

const data = await response.json();
writeFileSync('/var/log/eliezer/seed-response.json', JSON.stringify(data, null, 2));

const output = prefill + (data.content?.[0]?.text || '');
writeFileSync('/var/log/eliezer/seed-output.mts', output);

console.log('Executing generated TypeScript...');
execSync('npx tsx /var/log/eliezer/seed-output.mts', {
  stdio: 'inherit',
  cwd: '/opt/eliezer'
});
BOOTSTRAP

# run bootstrap (Phase 0 generation)
node /tmp/bootstrap.mjs

# immortal loop - handles all phase transitions
echo "Starting phase runner..."
while true; do
  if [ -f /opt/eliezer/phase2.mjs ]; then
    echo "[runner] Running phase2.mjs"
    npx tsx /opt/eliezer/phase2.mjs || echo "[runner] phase2 exited with $?"
  elif [ -f /opt/eliezer/phase1.mjs ]; then
    echo "[runner] Running phase1.mjs"
    npx tsx /opt/eliezer/phase1.mjs || echo "[runner] phase1 exited with $?"
  else
    echo "[runner] No phase file found, waiting..."
  fi
  sleep 2
done
SCRIPT_EOF

chmod +x "$OUTPUT"
echo "Generated: $OUTPUT"
