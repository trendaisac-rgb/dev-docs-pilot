#!/usr/bin/env bash
# One-shot setup + ingest for docs-agent
# Run: bash setup_and_run.sh

set -e

# ─── Colors ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; }

# ─── Paths ──────────────────────────────────────────────────────────
REPO_ROOT="/Users/doug/Desktop/Claude/Cloud Test/dev-docs-pilot"
API_DIR="$REPO_ROOT/api"

cd "$REPO_ROOT"

# ─── 0. Sanity ──────────────────────────────────────────────────────
step "Sanity checks"
if [ ! -f "$API_DIR/.env" ]; then
  err "api/.env not found. Did you copy from .env.example and fill the keys?"
  exit 1
fi
ok ".env found at $API_DIR/.env"

# Verify .env has real values (not placeholders)
missing=0
for var in ANTHROPIC_API_KEY OPENAI_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  val=$(grep -E "^${var}=" "$API_DIR/.env" | head -1 | cut -d= -f2-)
  if [ -z "$val" ] || echo "$val" | grep -qE "^(sk-ant-\.\.\.|sk-\.\.\.|eyJ\.\.\.|https://YOUR_PROJECT|\.\.\.)$"; then
    err "$var is missing or still a placeholder"
    missing=1
  fi
done
[ $missing -eq 1 ] && exit 1
ok ".env has all 4 required keys"

# ─── 1. Install uv if missing ───────────────────────────────────────
step "Checking uv"
if ! command -v uv >/dev/null 2>&1; then
  warn "uv not installed — installing now (~30s)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if ! command -v uv >/dev/null 2>&1; then
    err "uv install completed but command still not found. Add ~/.local/bin to PATH manually and re-run."
    exit 1
  fi
fi
ok "uv $(uv --version)"

# ─── 2. uv sync ─────────────────────────────────────────────────────
step "uv sync (resolving + installing Python deps)"
cd "$API_DIR"
uv sync
ok "Deps installed at $API_DIR/.venv"

# ─── 3. Run ingest ──────────────────────────────────────────────────
step "Running docs-agent-ingest (crawl + chunk + embed + write to Supabase)"
echo "  This takes ~6-10 minutes. Don't close the terminal."
echo "  Log saved to /tmp/ingest.log"
echo ""
uv run docs-agent-ingest 2>&1 | tee /tmp/ingest.log

# ─── 4. Verify ──────────────────────────────────────────────────────
step "Verification"
if grep -q "Done." /tmp/ingest.log; then
  chunks=$(grep -oE 'wrote [0-9]+/[0-9]+' /tmp/ingest.log | tail -1)
  ok "Ingest finished — final batch: $chunks"
else
  err "Ingest did not complete cleanly. Check /tmp/ingest.log"
  exit 1
fi

echo ""
echo -e "${GREEN}━━━ ALL DONE ━━━${NC}"
echo ""
echo "Next steps:"
echo "  1. Start the API:    cd \"$API_DIR\" && uv run uvicorn docs_agent.api.main:app --reload"
echo "  2. (In a new tab) Run the eval: cd \"$API_DIR\" && uv run python -m eval.run_eval"
echo ""
