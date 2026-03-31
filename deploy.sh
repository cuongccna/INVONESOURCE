#!/usr/bin/env bash
# deploy.sh — INVONE Platform deployment script
# Usage: bash deploy.sh [--skip-build] [--skip-migrate]
# Run from: /opt/INVONESOURCE/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

SKIP_BUILD=false
SKIP_MIGRATE=false
for arg in "$@"; do
  case $arg in
    --skip-build)   SKIP_BUILD=true   ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
  esac
done

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── Preflight checks ──────────────────────────────────────────────────────────
info "Preflight checks..."
[[ -f "$SCRIPT_DIR/.env" ]] || error ".env not found at $SCRIPT_DIR/.env — create it first"
command -v node  >/dev/null || error "node not found"
command -v npm   >/dev/null || error "npm not found"
command -v pm2   >/dev/null || error "pm2 not found (npm i -g pm2)"
command -v psql  >/dev/null || error "psql not found"

# ── Bot .env symlink ──────────────────────────────────────────────────────────
info "Ensuring bot/.env symlink..."
if [[ ! -L "$SCRIPT_DIR/bot/.env" ]]; then
  ln -sf "$SCRIPT_DIR/.env" "$SCRIPT_DIR/bot/.env"
  info "Created symlink: bot/.env → $SCRIPT_DIR/.env"
else
  info "bot/.env symlink already exists"
fi

# ── Install dependencies ──────────────────────────────────────────────────────
info "Installing workspace dependencies (backend + frontend + shared)..."
npm install --workspaces --include-workspace-root

info "Installing bot dependencies (standalone)..."
cd bot && npm install && cd "$SCRIPT_DIR"

# ── Database migrations ───────────────────────────────────────────────────────
if [[ "$SKIP_MIGRATE" == false ]]; then
  info "Running database migrations..."

  # Load DB connection from .env
  set -a; source "$SCRIPT_DIR/.env"; set +a

  # Extract DB name from DATABASE_URL for schema grant
  DB_NAME="$(echo "$DATABASE_URL" | sed 's|.*\/||')"
  DB_USER="$(echo "$DATABASE_URL" | sed 's|postgresql://||;s|:.*||')"

  # Grant schema permissions (PostgreSQL 15+ requires explicit GRANT on public schema)
  info "Granting schema privileges to $DB_USER on $DB_NAME..."
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\";" 2>/dev/null || \
    warn "Could not grant schema privileges (may need manual: sudo -u postgres psql -d $DB_NAME -c 'GRANT ALL ON SCHEMA public TO $DB_USER;')"

  run_sql() {
    local file="$1"
    info "  → $file"
    psql "$DATABASE_URL" -f "$file" -v ON_ERROR_STOP=1
  }

  run_js() {
    local file="$1"
    info "  → $file (JS)"
    node "$file"
  }

  cd "$SCRIPT_DIR/scripts"

  run_sql 001_init.sql
  run_sql 002_tax_declarations.sql
  run_sql 003_multi_company.sql
  run_sql 004_auth_hardening.sql
  run_sql 005_hierarchy.sql
  run_sql 006_crm.sql
  run_sql 007_advanced_analytics.sql
  run_sql 008_fix_numeric_overflow.sql
  run_sql 008_sync_indexes.sql
  run_sql 009_gdt_viettel_validated.sql
  run_sql 010_gdt_bot_security.sql
  run_sql 011_missing_columns.sql
  run_sql 012_groups_36_41.sql
  run_sql 013_soft_delete.sql
  run_sql 014_gdt_bot_provider.sql
  run_js  015_fix_invoice_upsert_index.js
  run_sql 016_quarterly_declarations.sql
  run_js  017_proxy_session_autoblock.js
  run_sql 018_fix_declaration_unique_constraint.sql
  run_sql 019_license_system.sql
  run_sql 020_normalize_declaration_fields.sql
  run_sql 021_line_items_manual.sql

  cd "$SCRIPT_DIR"
  info "All migrations applied."
else
  warn "Skipping migrations (--skip-migrate)"
fi

# ── Build ─────────────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false ]]; then

  info "Building backend (TypeScript → dist/)..."
  cd "$SCRIPT_DIR/backend"
  npm run build

  info "Building bot (TypeScript → dist/)..."
  cd "$SCRIPT_DIR/bot"
  npm run build

  info "Installing Playwright Chromium (bot)..."
  npx playwright install chromium --with-deps

  info "Building frontend (Next.js production build)..."
  cd "$SCRIPT_DIR/frontend"

  # Inject NEXT_PUBLIC_API_URL into frontend/.env.production.local
  # (Next.js reads frontend/ directory only; root .env is NOT in its search path)
  set -a; source "$SCRIPT_DIR/.env"; set +a
  NEXT_PUBLIC_API_URL_VAL="${NEXT_PUBLIC_API_URL:-https://api.autopostvn.cloud}"
  echo "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL_VAL}" > .env.production.local
  echo "NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}" >> .env.production.local
  info "Wrote frontend/.env.production.local (NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL_VAL})"

  npm run build

  cd "$SCRIPT_DIR"
else
  warn "Skipping builds (--skip-build)"
fi

# ── PM2 start / reload ────────────────────────────────────────────────────────
info "Starting / reloading PM2 processes..."
if pm2 list | grep -q "invone-backend"; then
  pm2 reload ecosystem.config.js --update-env
  info "PM2 reloaded via ecosystem.config.js"
else
  pm2 start ecosystem.config.js
  pm2 save
  info "PM2 started and saved"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
info "✓ Deployment complete."
echo ""
pm2 list
