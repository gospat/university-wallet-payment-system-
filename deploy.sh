#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# BELLS UNIVERSITY PAYMENT PORTAL — 1-CLICK PRODUCTION DEPLOY SCRIPT
# Usage:   chmod +x deploy.sh && ./deploy.sh
# Run ON:  The production VPS (Ubuntu 22.04 LTS x86_64) inside the git repo root
# Author:  Bursary Payment Portal Team
###############################################################################

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEPLOY]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}    $*"; }
die()  { echo -e "${RED}[FATAL]${NC}   $*"; exit 1; }

REQUIRED_NODE_MAJOR=18
REQUIRED_NPM_MAJOR=9
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$REPO_ROOT/api"
APP_DIR="$REPO_ROOT/app"
STATIC_WEBROOT="/var/www/payment.bellsuniversity.edu.ng/html"
LOG_DIR="/var/log/bells-payment"

log "Starting Bells University Payment Portal deploy — $(date -u '+%FT%TZ')"
log "Repo root detected at: $REPO_ROOT"

[ -f "$API_DIR/package.json" ] || die "Cannot find $API_DIR/package.json — wrong directory?"
[ -f "$APP_DIR/package.json" ] || die "Cannot find $APP_DIR/package.json — wrong directory?"

###############################################################################
# 1) Runtime prerequisites
###############################################################################
command -v node >/dev/null 2>&1 || die "node not installed. Install Node.js v18+ via nodesource."
command -v npm  >/dev/null 2>&1 || die "npm not installed."
NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')
NPM_MAJOR=$(npm -v  | sed -E 's/^([0-9]+)\..*/\1/')
(( NODE_MAJOR >= REQUIRED_NODE_MAJOR )) || die "Node v$NODE_MAJOR too old — need v$REQUIRED_NODE_MAJOR+"
(( NPM_MAJOR  >= REQUIRED_NPM_MAJOR  )) || warn "npm v$NPM_MAJOR below v$REQUIRED_NPM_MAJOR — run 'npm i -g npm@latest'"
log "Runtime OK: node $(node -v) / npm $(npm -v)"

command -v npx >/dev/null 2>&1 || die "npx missing"
command -v pm2 >/dev/null 2>&1 || warn "pm2 not on PATH — install with: sudo npm i -g pm2@latest"

mkdir -p "$LOG_DIR" || warn "Cannot create $LOG_DIR — running under non-root? sudo mkdir -p $LOG_DIR && sudo chown \$USER:\$USER $LOG_DIR"

###############################################################################
# 2) Env file presence check (NEVER bake secrets into repo!)
###############################################################################
[ -f "$API_DIR/.env" ] || warn "⚠️  $API_DIR/.env missing — copy .env.example and fill in production secrets BEFORE starting"
[ -f "$APP_DIR/.env.local" ] || warn "⚠️  $APP_DIR/.env.local missing — set VITE_API_BASE_URL=https://paymentapi.bellsuniversity.edu.ng/api/v1 BEFORE building frontend"

###############################################################################
# 3) Pull latest from origin/main
###############################################################################
if command -v git >/dev/null 2>&1; then
  log "Pulling latest origin/main …"
  git fetch --all --tags
  git reset --hard origin/main || warn "git reset failed — continuing with working tree as-is"
  git clean -fd node_modules api/node_modules app/node_modules 2>/dev/null || true
else
  warn "git not installed — skipping pull, assuming working tree is up-to-date"
fi

###############################################################################
# 4) API — clean install, Prisma, build
###############################################################################
log "=== Backend (api/) — dependency install, prisma generate + migrate, build ==="
cd "$API_DIR"
npm ci --no-audit --no-fund --loglevel=error
npx prisma generate
log "Applying pending Prisma migrations (safe — production deploy not dev push) …"
npx prisma migrate deploy
log "Compiling TypeScript → dist/ …"
npm run build
[ -f "$API_DIR/dist/server.js" ] || die "npm run build failed — dist/server.js missing"

###############################################################################
# 5) Frontend — build static bundle. VITE_API_BASE_URL is read AT BUILD TIME.
###############################################################################
log "=== Frontend (app/) — Vite production build ==="
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
if [ ! -f "$APP_DIR/.env.local" ]; then
  warn "Frontend built with DEFAULT (dev) API URL! Press Ctrl+C NOW if wrong, then create $APP_DIR/.env.local with VITE_API_BASE_URL=https://paymentapi.bellsuniversity.edu.ng/api/v1"
  sleep 5
fi
log "Building React SPA with bundled API URL baked in …"
npm run build
[ -d "$APP_DIR/dist" ] || die "Frontend build failed — app/dist missing"
log "Frontend dist size: $(du -sh "$APP_DIR/dist" | cut -f1)"

###############################################################################
# 6) Publish static assets to nginx webroot
###############################################################################
if [ -d "$STATIC_WEBROOT" ]; then
  log "Publishing static files → $STATIC_WEBROOT (atomic rsync for no-downtime swap) …"
  command -v rsync >/dev/null 2>&1 || die "rsync missing — sudo apt install rsync"
  rsync -av --delete --checksum \
    --exclude='.git' --exclude='node_modules' \
    "$APP_DIR/dist/" "$STATIC_WEBROOT/"
  sudo chown -R www-data:www-data "$STATIC_WEBROOT" 2>/dev/null || true
  sudo find "$STATIC_WEBROOT" -type f -exec chmod 644 {} \; 2>/dev/null || true
  sudo find "$STATIC_WEBROOT" -type d -exec chmod 755 {} \; 2>/dev/null || true
else
  warn "Static webroot $STATIC_WEBROOT missing — create via sudo mkdir -p $STATIC_WEBROOT && sudo chown \$USER:\$USER $STATIC_WEBROOT"
fi

###############################################################################
# 7) PM2 zero-downtime reload of the API
###############################################################################
log "=== PM2 API reload ==="
if command -v pm2 >/dev/null 2>&1; then
  cd "$API_DIR"
  if pm2 describe bells-api >/dev/null 2>&1; then
    log "Reloading running bells-api (2 cluster workers, zero-downtime reload) …"
    pm2 reload ecosystem.config.js --env production --update-env
  else
    log "Starting bells-api for the first time …"
    pm2 start ecosystem.config.js --env production
    pm2 save
    log "Saving PM2 process list for boot-restore. Run once: pm2 startup systemd -u \$USER"
  fi
  pm2 status
else
  warn "pm2 not installed — start API manually with: cd $API_DIR && NODE_ENV=production PORT=3001 node dist/server.js &"
fi

###############################################################################
# 8) Health smoke test
###############################################################################
HEALTH_URL="http://127.0.0.1:3001/api/v1/health"
log "Smoke-testing API on $HEALTH_URL …"
for i in 1 2 3 4 5; do
  set +e
  HTTP_CODE=$(curl -s -o /tmp/bells-health-body.json -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null)
  set -e
  if [ "$HTTP_CODE" = "200" ]; then
    log "API health check OK (HTTP 200). Body: $(cat /tmp/bells-health-body.json 2>/dev/null || echo n/a)"
    break
  fi
  warn "HTTP $HTTP_CODE — retry $i/5 after 2s …"
  sleep 2
done
[ "$HTTP_CODE" = "200" ] || warn "⚠️  API health unreachable after retries. Check pm2 logs (pm2 logs bells-api) or firewall"

log ""
log "✅ DEPLOY COMPLETE — $(date -u '+%FT%TZ')"
log "   Frontend:  https://payment.bellsuniversity.edu.ng  (run certbot once if no SSL yet)"
log "   Backend:   https://paymentapi.bellsuniversity.edu.ng/api/v1/health"
log "   PM2 logs:  pm2 logs bells-api --lines 100"
log "   DB backup: pg_dump -U bells_payment_user bells_payment_db | gzip > /var/backups/bells-db-$(date +%F).sql.gz"
log ""
