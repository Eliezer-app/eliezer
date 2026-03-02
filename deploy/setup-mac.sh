#!/bin/bash
set -euo pipefail

# Mac bare-metal setup for Eliezer
# Run from the repo root: bash deploy/setup-mac.sh

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "=== Eliezer Mac Setup ==="
echo "App directory: $APP_DIR"
echo ""

# --- Docker (for SearXNG) — check first, before installing anything ---
if ! command -v docker &>/dev/null; then
	echo "Docker not found. Install Docker Desktop manually:"
	echo "  https://docs.docker.com/desktop/install/mac-install/"
	echo "  or: brew install --cask docker"
	echo ""
	echo "After installing, open Docker Desktop once to complete setup,"
	echo "then re-run this script."
	exit 1
fi

if ! docker info &>/dev/null; then
	echo "Docker is installed but not running. Start Docker Desktop, then re-run."
	exit 1
fi

# --- Homebrew ---
if ! command -v brew &>/dev/null; then
	echo "Installing Homebrew..."
	/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# --- Node.js 22 ---
if ! command -v node &>/dev/null; then
	echo "Installing Node.js 22..."
	brew install node@22
	brew link --overwrite node@22
elif [[ "$(node -v)" != v22.* ]]; then
	echo "Warning: Node.js $(node -v) found, but 22.x is recommended."
	echo "  brew install node@22 && brew link --overwrite node@22"
fi

# --- npm dependencies ---
echo "Installing npm dependencies..."
npm ci

# --- Prompts ---
mkdir -p prompts
cp -rn prompts-default/* prompts/ 2>/dev/null || true
echo "Prompts copied to prompts/ (yours to edit)."

# --- State directory ---
mkdir -p state

# --- .env ---
if [ ! -f .env ]; then
	cp .env.example .env
	# Enable system Chrome for Mac
	sed -i '' 's|^# PUPPETEER_EXECUTABLE_PATH=|PUPPETEER_EXECUTABLE_PATH=|' .env
	echo ""
	echo "Created .env — edit it with your API keys:"
	echo "  $APP_DIR/.env"
	echo ""
	echo "After editing .env, re-run this script to start SearXNG."
	exit 0
fi

# --- SearXNG (Docker) ---
echo "Starting SearXNG..."
docker rm -f searxng 2>/dev/null || true
docker run -d --name searxng --restart unless-stopped \
	-p 127.0.0.1:8080:8080 \
	-e SEARXNG_BASE_URL=http://localhost:8080 \
	-v "$APP_DIR/config/searxng/settings.yml:/etc/searxng/settings.yml" \
	searxng/searxng

echo ""
echo "=== Setup complete ==="
echo ""
echo "SearXNG running on http://localhost:8080"
echo ""
echo "To start Eliezer:"
echo "  cd $APP_DIR"
echo "  npx tsx eliezer.mts"
echo ""
echo "Health check: curl http://localhost:3200/info/health"
