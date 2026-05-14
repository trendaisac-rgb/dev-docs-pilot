#!/usr/bin/env bash
# Deploy the chat Edge Function to Supabase (Mavryx-style runtime).
# Pushes secrets from api/.env to Supabase, links the project, deploys.
#
# Run: bash deploy_edge_function.sh

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; }

REPO="/Users/doug/Desktop/Claude/Cloud Test/dev-docs-pilot"
PROJECT_REF="qonbpdqlkfsiosdkzjtf"

cd "$REPO"

# ── 1. supabase CLI installed? ───────────────────────────────────────
step "Checking Supabase CLI"
if ! command -v supabase >/dev/null 2>&1; then
  warn "supabase CLI not installed — installing via Homebrew"
  if command -v brew >/dev/null 2>&1; then
    brew install supabase/tap/supabase
  else
    err "Homebrew not found. Install supabase manually: https://supabase.com/docs/guides/local-development/cli/getting-started"
    exit 1
  fi
fi
ok "supabase $(supabase --version)"

# ── 2. Logged in? ────────────────────────────────────────────────────
step "Checking Supabase login"
# `supabase projects list` errors if not authed
if ! supabase projects list >/dev/null 2>&1; then
  warn "Not logged in — opening browser"
  supabase login
fi
ok "Logged in"

# ── 3. Link project ──────────────────────────────────────────────────
step "Linking project '$PROJECT_REF'"
if [ ! -f ".supabase/.temp/cli-latest" ]; then
  supabase link --project-ref "$PROJECT_REF"
fi
ok "Linked"

# ── 4. Push secrets from api/.env ────────────────────────────────────
step "Pushing secrets to Edge Function"
if [ ! -f "api/.env" ]; then
  err "api/.env missing — copy from .env.example and fill values first"
  exit 1
fi

# Only the runtime-needed secrets — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# are auto-injected by Supabase into Edge Functions.
declare -a SECRET_VARS=(
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  ANTHROPIC_AGENT_MODEL
  ANTHROPIC_JUDGE_MODEL
  EMBED_MODEL
  RAG_MATCH_COUNT
  KB_HIGH_CONFIDENCE_SIM
)
SECRET_ARGS=()
for var in "${SECRET_VARS[@]}"; do
  val=$(grep -E "^${var}=" "api/.env" | head -1 | cut -d= -f2-)
  if [ -n "$val" ]; then
    SECRET_ARGS+=("${var}=${val}")
  fi
done

if [ ${#SECRET_ARGS[@]} -eq 0 ]; then
  err "No secrets found in api/.env"
  exit 1
fi

supabase secrets set --project-ref "$PROJECT_REF" "${SECRET_ARGS[@]}" >/dev/null
ok "Pushed ${#SECRET_ARGS[@]} secrets"

# ── 5. Deploy ────────────────────────────────────────────────────────
step "Deploying chat function"
supabase functions deploy chat --project-ref "$PROJECT_REF" --no-verify-jwt
ok "Deployed"

# ── 6. Smoke test ────────────────────────────────────────────────────
step "Smoke test"
FUNC_URL="https://${PROJECT_REF}.supabase.co/functions/v1/chat"
ANON_KEY=$(grep "^SUPABASE_ANON_KEY=" "api/.env" | head -1 | cut -d= -f2-)

echo "  Hitting $FUNC_URL with a simple question..."
echo "  (this proves the deploy reached the Edge runtime — full agent loop"
echo "   may take 10-30s; we just check the connection is up.)"
echo ""
curl -sS -N "$FUNC_URL" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is Claude Sonnet?"}' \
  -m 60 | head -c 2000
echo ""
echo ""

echo -e "${GREEN}━━━ DEPLOYED ━━━${NC}"
echo ""
echo "Edge Function URL: ${BLUE}$FUNC_URL${NC}"
echo ""
echo "Logs:    supabase functions logs chat --project-ref $PROJECT_REF"
echo "Redeploy: supabase functions deploy chat --project-ref $PROJECT_REF --no-verify-jwt"
echo ""
echo "Next: point the Lovable frontend at this URL (or use supabase.functions.invoke('chat', ...) directly)."
