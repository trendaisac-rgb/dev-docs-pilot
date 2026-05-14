#!/usr/bin/env bash
# One-shot deploy of the docs-agent backend to Fly.io.
# Reads secrets from api/.env and pushes them to Fly via `flyctl secrets`.
#
# Run: bash deploy_backend.sh

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; }

REPO="/Users/doug/Desktop/Claude/Cloud Test/dev-docs-pilot"
API_DIR="$REPO/api"
APP_NAME="docs-agent"

cd "$API_DIR"

# ── 1. flyctl installed? ─────────────────────────────────────────────
step "Checking flyctl"
if ! command -v flyctl >/dev/null 2>&1; then
  warn "flyctl not installed — installing (Homebrew or curl)"
  if command -v brew >/dev/null 2>&1; then
    brew install flyctl
  else
    curl -L https://fly.io/install.sh | sh
    export FLYCTL_INSTALL="$HOME/.fly"
    export PATH="$FLYCTL_INSTALL/bin:$PATH"
  fi
fi
ok "flyctl $(flyctl version | head -1)"

# ── 2. Logged in? ────────────────────────────────────────────────────
step "Checking Fly.io auth"
if ! flyctl auth whoami >/dev/null 2>&1; then
  warn "Not logged in — opening browser for signup/login"
  flyctl auth signup || flyctl auth login
fi
ok "Logged in as $(flyctl auth whoami)"

# ── 3. App exists? ───────────────────────────────────────────────────
step "Checking app '$APP_NAME'"
if flyctl status -a "$APP_NAME" >/dev/null 2>&1; then
  ok "App exists"
else
  warn "App doesn't exist — creating with 'flyctl launch'"
  # --copy-config uses our fly.toml as-is; --no-deploy waits for secrets
  flyctl launch --copy-config --no-deploy --name "$APP_NAME" --yes
fi

# ── 4. Push secrets from .env ────────────────────────────────────────
step "Pushing secrets from api/.env"
if [ ! -f "$API_DIR/.env" ]; then
  err "api/.env missing — copy from .env.example and fill values first"
  exit 1
fi

# Read secrets, filter to only the ones we need, build the args string.
declare -a SECRET_VARS=(
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
)
SECRET_ARGS=()
for var in "${SECRET_VARS[@]}"; do
  val=$(grep -E "^${var}=" "$API_DIR/.env" | head -1 | cut -d= -f2-)
  if [ -z "$val" ]; then
    err "$var not found in api/.env"
    exit 1
  fi
  SECRET_ARGS+=("${var}=${val}")
done

flyctl secrets set -a "$APP_NAME" --stage "${SECRET_ARGS[@]}" >/dev/null
ok "Pushed ${#SECRET_VARS[@]} secrets (staged for next deploy)"

# ── 5. Deploy ────────────────────────────────────────────────────────
step "Building image + deploying"
flyctl deploy -a "$APP_NAME" --ha=false

# ── 6. Verify ────────────────────────────────────────────────────────
step "Verifying"
URL="https://${APP_NAME}.fly.dev"
ok "App URL: $URL"

# Hit /healthz with a generous timeout to account for cold-start.
for i in 1 2 3 4 5; do
  code=$(curl -sL -o /dev/null -w "%{http_code}" -m 15 "$URL/healthz")
  if [ "$code" = "200" ]; then
    ok "Health check passed ($URL/healthz returned 200)"
    break
  fi
  warn "Health check $i/5 returned $code — retrying in 5s"
  sleep 5
done

echo ""
echo -e "${GREEN}━━━ DEPLOYED ━━━${NC}"
echo ""
echo "Backend live at: ${BLUE}$URL${NC}"
echo ""
echo "Next: point the Lovable frontend at this URL."
echo "  Settings gear → Backend URL → $URL → Save"
echo ""
echo "Test from your shell:"
echo "  curl -X POST $URL/ask \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"question\": \"How do I stream a response from the Messages API?\"}'"
echo ""
