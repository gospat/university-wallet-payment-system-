# BELLS UNIVERSITY OF TECHNOLOGY — BURSARY PAYMENT PORTAL
## PRODUCTION DEPLOYMENT CHECKLIST — Ubuntu 22.04 LTS VPS (Option A)

**Target Architecture:** Single VPS (4 vCPU / 8GB RAM / 100GB SSD) in Lagos datacenter
  - 🛰️ API:        paymentapi.bellsuniversity.edu.ng  → 127.0.0.1:3001 (Node.js/Express + PM2)
  - 🖥️ Frontend:   payment.bellsuniversity.edu.ng    → static /var/www/.../html (Nginx)
  - 🗄️ PostgreSQL:  127.0.0.1:5432 (no public network access!)
  - 🧮 Redis:       127.0.0.1:6379 (BullMQ email queue + rate limit + idempotency cache)
  - 📧 SMTP:        Resend with bellsuniversity.edu.ng custom domain (SPF/DKIM/DMARC)
  - 💳 Payments:    Paystack (primary) / ALAT Pay (WEMA Bank) — production API keys

---

## PHASE 0 — Procure VPS + DNS

- [ ] Buy a VPS at RackServe/HostAfrica/Hostnownow (Lagos/Ibadan): **4 vCPU / 8GB RAM / 100GB NVMe**, Ubuntu 22.04 LTS
- [ ] Assign IPv4 + note IP, e.g. `197.211.X.Y`
- [ ] In Bells University domain registrar (www.bellsuniversity.edu.ng):
  - [ ] Add **A record** `payment.bellsuniversity.edu.ng    → 197.211.X.Y`   (FRONTEND)
  - [ ] Add **A record** `paymentapi.bellsuniversity.edu.ng → 197.211.X.Y`   (BACKEND API)
- [ ] Confirm both resolve: `dig +short payment.bellsuniversity.edu.ng` + `dig +short paymentapi.bellsuniversity.edu.ng` both return your VPS IP

---

## PHASE 1 — First-Boot VPS Hardening (sudo -i as root)

```bash
apt update && apt full-upgrade -y
apt install -y ca-certificates curl gnupg lsb-release ufw unzip git rsync wget nano htop iotop jq

# ⚠️ IMMEDIATELY after first SSH login: DISABLE password + root SSH.
# Make sure your `deploy` user has a key added first.
adduser deploy --gecos ""
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
# Paste YOUR workstation's ~/.ssh/id_rsa.pub into /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh

# UFW firewall — ONLY allow SSH, HTTP, HTTPS. Postgres/Redis/3001 NEVER exposed!
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'SSH with rate limit'
ufw allow 80/tcp  comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

# Fail2ban to block SSH brute force
apt install -y fail2ban
systemctl enable --now fail2ban

# Automatic security updates (NDPR requirement — critical patches install automatically)
apt install -y unattended-upgrades apt-listchanges
dpkg-reconfigure -plow unattended-upgrades   # select YES

# Timezone to Lagos (correct timestamps on receipts/audit logs!)
timedatectl set-timezone Africa/Lagos
```

---

## PHASE 2 — Install Runtimes

```bash
# ===== Node.js 20.x LTS (nodesource PPA) =====
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v          # expect v20.x + 10.x
sudo npm i -g npm@latest pm2@latest
pm2 startup systemd -u deploy --hp /home/deploy   # follow the command it prints

# ===== PostgreSQL 16 =====
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt update && sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql

# ===== Redis 7 =====
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt update && sudo apt install -y redis-server
sudo systemctl enable --now redis-server

# Puppeteer (watermarked PDFs, receipts) system deps
sudo apt install -y \
  chromium-browser fonts-liberation fonts-noto-color-emoji \
  libgbm1 libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
  libdbus-1-3 libdrm2 libnspr4 libnss3 libpango-1.0-0 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils

# Nginx + Certbot (ACME SSL)
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nginx -v
```

---

## PHASE 3 — PostgreSQL + Redis Initial Setup

```bash
# === Create DB + user ===
sudo -u postgres psql
-- Inside psql:
CREATE USER bells_payment_user WITH PASSWORD 'USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE';
CREATE DATABASE bells_payment_db OWNER bells_payment_user;
REVOKE ALL ON DATABASE bells_payment_db FROM PUBLIC;
GRANT CONNECT ON DATABASE bells_payment_db TO bells_payment_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO bells_payment_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO bells_payment_user;
\q

# === Harden Postgres: NO external listen, scram-sha-256 only ===
sudo sed -i "s|#listen_addresses = 'localhost'|listen_addresses = '127.0.0.1'|g" /etc/postgresql/16/main/postgresql.conf
sudo sed -i "s|^host    all             all             127.0.0.1/32.*|host    all             all             127.0.0.1/32            scram-sha-256|" /etc/postgresql/16/main/pg_hba.conf
sudo systemctl restart postgresql

# Verify login works:
PGPASSWORD='USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE' psql -h 127.0.0.1 -U bells_payment_user -d bells_payment_db -c "SELECT version();"

# === Redis password + disable external ===
sudo tee -a /etc/redis/redis.conf <<'EOF'
bind 127.0.0.1
protected-mode yes
requirepass REDIS-LONG-RANDOM-PASSWORD-64CHARS
rename-command FLUSHALL ""
rename-command CONFIG  ""
EOF
sudo systemctl restart redis-server
redis-cli -a REDIS-LONG-RANDOM-PASSWORD-64CHARS ping   # expect PONG
```

---

## PHASE 4 — First Deploy

```bash
# === Clone repo as deploy user ===
sudo mkdir -p /var/www/bells-payment /var/www/payment.bellsuniversity.edu.ng/html /var/log/bells-payment /var/www/_letsencrypt /var/backups
sudo chown -R deploy:deploy /var/www/bells-payment /var/www/payment.bellsuniversity.edu.ng/html /var/log/bells-payment
sudo usermod -aG www-data deploy

su - deploy
git clone git@github.com:gospat/university-wallet-payment-system-.git /var/www/bells-payment
cd /var/www/bells-payment

# === Populate api/.env with PRODUCTION values (copy .env.example and OVERWRITE) ===
# CRITICAL: NEVER commit real secrets to git! NEVER use dev JWT_SECRET in prod!
cp api/.env.example api/.env
nano api/.env
# Fill these values in api/.env:
#   NODE_ENV=production
#   PORT=3001
#   DATABASE_URL=postgresql://bells_payment_user:USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE@127.0.0.1:5432/bells_payment_db?schema=public
#   JWT_SECRET=<openssl rand -hex 48  → run this, paste output 96 chars>
#   JWT_REFRESH_SECRET=<openssl rand -hex 48 → different from above>
#   JWT_EXPIRES_IN=15m
#   JWT_REFRESH_EXPIRES_IN=7d
#   REDIS_URL=redis://:REDIS-LONG-RANDOM-PASSWORD-64CHARS@127.0.0.1:6379/0
#   CORS_ORIGIN=https://payment.bellsuniversity.edu.ng
#   PUBLIC_URL=https://payment.bellsuniversity.edu.ng
#   PUBLIC_API_URL=https://paymentapi.bellsuniversity.edu.ng/api/v1
#   PAYSTACK_SECRET_KEY=sk_live_xxx        (Paystack dashboard → API Keys)
#   PAYSTACK_PUBLIC_KEY=pk_live_xxx
#   PAYSTACK_WEBHOOK_SECRET=<copy from Paystack Dashboard Webhook settings>
#   ALATPAY_CLIENT_ID=prod-xxx             (Wema/ALAT Pay)
#   ALATPAY_CLIENT_SECRET=prod-xxx
#   ALATPAY_WEBHOOK_SECRET=prod-xxx
#   DEFAULT_PAYMENT_PROVIDER=ALATPAY       # or PAYSTACK
#   RESEND_API_KEY=re_xxx                  (resend.com)
#   MAIL_FROM=noreply@bellsuniversity.edu.ng
#   BURSARY_EMAIL=bursary@bellsuniversity.edu.ng
#   SENTRY_DSN=                            # optional error tracking, leave blank if none

# === Populate app/.env.local for frontend build (URL gets BAKED into JS) ===
cat > app/.env.local <<'EOF'
VITE_API_BASE_URL=https://paymentapi.bellsuniversity.edu.ng/api/v1
EOF

# === Run 1-click deploy ===
chmod +x deploy.sh
./deploy.sh
# Watch the output. Expected: "✅ DEPLOY COMPLETE" + API health HTTP 200.
```

If deploy.sh succeeds, you should now have:
  - React SPA built in `app/dist/` and rsync'd to `/var/www/payment.bellsuniversity.edu.ng/html/`
  - Node API running on 127.0.0.1:3001 via 2 PM2 cluster workers
  - `pm2 status` → `bells-api` is `online` for both workers

---

## PHASE 5 — Nginx + Let's Encrypt SSL

```bash
# (As user with sudo — root or deploy)
sudo cp /var/www/bells-payment/nginx/payment.bellsuniversity.edu.ng.conf    /etc/nginx/sites-available/
sudo cp /var/www/bells-payment/nginx/paymentapi.bellsuniversity.edu.ng.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/payment.bellsuniversity.edu.ng.conf    /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/paymentapi.bellsuniversity.edu.ng.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t        # MUST say test is successful
sudo systemctl reload nginx

# ===== SSL: Run certbot ONCE per domain =====
sudo certbot --nginx -n --agree-tos -m devops@bellsuniversity.edu.ng -d payment.bellsuniversity.edu.ng    --redirect
sudo certbot --nginx -n --agree-tos -m devops@bellsuniversity.edu.ng -d paymentapi.bellsuniversity.edu.ng --redirect
sudo systemctl status certbot.timer   # auto-renewal should be active (runs 2x/day)
```

## TEST SSL + CORS
```bash
# From ANY machine:
curl -I https://payment.bellsuniversity.edu.ng/          # HTTP 200, Strict-Transport-Security header
curl -v https://paymentapi.bellsuniversity.edu.ng/api/v1/health  # HTTP 200 JSON success

# From the VPS itself (bypass nginx, sanity-check raw API):
curl -s http://127.0.0.1:3001/api/v1/health | jq .
```

If CORS or HSTS headers missing → reload nginx with `sudo systemctl reload nginx`

---

## PHASE 6 — DNS Records for Email Deliverability (Resend)
Bells IT team must add these 3 records to the bellsuniversity.edu.ng DNS zone
in the domain registrar / cPanel:

| Type  | Host                          | Value                                                                     |
|-------|-------------------------------|---------------------------------------------------------------------------|
| CNAME | `bells-email`                 | `rs1.resend.net`                                                          |
| TXT   | `_dmarc.bells-email`          | `v=DMARC1; p=quarantine; rua=mailto:devops@bellsuniversity.edu.ng; fo=1;` |
| TXT   | @ (root if portal uses 1 mail) OR `_dmarc` | `v=DMARC1; p=none; rua=mailto:devops@bellsuniversity.edu.ng;`  (start with p=none, later upgrade to p=reject after 2 weeks of reports) |

After adding: press **Verify DNS Records** in Resend dashboard → wait for "Ready to send".

Test from VPS:
```bash
# Call your /api/v1/auth/forgot-password endpoint with finance@university.edu.ng
# OR run a simple curl with test script. Confirm that reset password email lands in Primary inbox, not Spam.
```

---

## PHASE 7 — Automated Backup (pg_dump + logs + branding uploads)

```bash
sudo tee /etc/cron.d/bells-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=devops@bellsuniversity.edu.ng

# Full PostgreSQL DB every day at 2:15 AM, gzipped, keep 30 days.
15 2 * * * deploy  PGPASSWORD=USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE /usr/bin/pg_dump -h 127.0.0.1 -U bells_payment_user -d bells_payment_db | gzip -c > /var/backups/bells-payment-db-$(date +\%F_\%H\%M).sql.gz ; find /var/backups -type f -name 'bells-payment-db-*.sql.gz' -mtime +30 -delete

# Rotate PM2 logs weekly
@weekly root  /usr/bin/su - deploy -c "pm2 flush" 2>&1 | logger -t bells-pm2-logrotate
EOF
sudo chmod 644 /etc/cron.d/bells-backup
sudo systemctl restart cron

# MANUAL TEST first-run:
sudo su - deploy -c 'PGPASSWORD=USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE pg_dump -h 127.0.0.1 -U bells_payment_user bells_payment_db | gzip -c > /tmp/test-backup.sql.gz && ls -lh /tmp/test-backup.sql.gz'
```

For OFF-SITE backup (fire, theft, ransomware):
- Copy backups nightly to Bells' Google Workspace Shared Drive using `rclone` with a service account JSON key, OR
- Sync to Backblaze B2 bucket (₦800/1TB/month).

---

## PHASE 8 — Smoke Test Payment Gateway Webhooks BEFORE Go-Live

**In Paystack / ALAT Pay Production Dashboards:**
- [ ] Set Paystack webhook URL to `https://paymentapi.bellsuniversity.edu.ng/api/v1/webhooks/paystack`
- [ ] Set ALAT Pay webhook URL to `https://paymentapi.bellsuniversity.edu.ng/api/v1/webhooks/alatpay`
- [ ] Use Paystack Test Mode → create a ₦100 invoice for student `student1@university.edu.ng`
- [ ] Simulate payment via test card → verify:
    - [ ] Paystack webhook arrives at API (inspect pm2 logs: `pm2 logs bells-api`)
    - [ ] Receipt PDF downloads from `/admin/receipts` page with watermark
    - [ ] Confirmation email lands in the test student inbox (Primary not Spam)

---

## PHASE 9 — Go-Live

- [ ] Login as **admin@university.edu.ng** / **admin123** → immediately FORCE admin password change on first login (ForcePasswordChangeGate already in place!)
- [ ] Create initial bursary users: `finance@bellsuniversity.edu.ng`
- [ ] Upload first academic session + faculties/colleges/departments via Bulk CSV Import
- [ ] Import first-year student data via Bulk XLSX
- [ ] Publish fees catalogue + do a small pilot with 10 students
- [ ] After pilot OK → announce portal to the students!

---

## PHASE 10 — Day-2 Operations Runbook (keep handy)

| Task | Command |
|---|---|
| Deploy new code | `cd /var/www/bells-payment && ./deploy.sh` |
| Check API health | `curl https://paymentapi.bellsuniversity.edu.ng/api/v1/health \| jq` |
| View live logs | `pm2 logs bells-api --lines 100` |
| Restart API | `pm2 reload bells-api --update-env` |
| Stop API | `pm2 stop bells-api` |
| Postgres status | `sudo systemctl status postgresql` |
| Redis status    | `sudo systemctl status redis-server` |
| Disk free       | `df -h /` — alert if >75% |
| Nginx reload    | `sudo nginx -t && sudo systemctl reload nginx` |
| Certbot dry-run | `sudo certbot renew --dry-run` |
| Security updates | `sudo apt update && sudo unattended-upgrade --dry-run -d` |
| Backup restore test (MONTHLY) | Restore last night's .sql.gz to a test DB, run Prisma validate on schema |

---

## 🔐 CRITICAL REMINDERS

1. **api/.env, app/.env.local** are IN .gitignore. NEVER `git add api/.env`. NEVER commit a production secret to a public/private GitHub repo.
2. Every 90 days: rotate JWT secrets, DB password, Redis password, Resend API keys.
3. `npx prisma migrate deploy` ALWAYS for production. NOT `npx prisma db push` (dev only).
4. The portal code already implements all OWASP Session-1 (SQLi, CSP, CSV formula magic bytes) + Session-2 (15min JWT + rotating refresh tokens). Keep NODE_ENV=production so error middleware never returns stack traces!
5. When in doubt about any step → ping the Bursary Payment Portal dev team first.
