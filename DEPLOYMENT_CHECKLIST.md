# BELLS UNIVERSITY OF TECHNOLOGY — BURSARY PAYMENT PORTAL
## PRODUCTION DEPLOYMENT CHECKLIST — Ubuntu 22.04 LTS VPS (Option A)

**Target Architecture:** Single VPS (4 vCPU / 8GB RAM / 100GB SSD) in Lagos datacenter
  - 🛰️ API:        paymentapi.bellsuniversity.edu.ng  → 127.0.0.1:3001 (Node.js/Express + PM2, MySQL 8 Prisma provider)
  - 🖥️ Frontend:   payment.bellsuniversity.edu.ng     → static /var/www/.../html (Nginx, React/Vite SPA)
  - 🗄️ MySQL 8.0:   127.0.0.1:3306 (Unix socket preferred, NO public TCP access!)
  - 🧮 Redis:       127.0.0.1:6379 (BullMQ email queue + RATE LIMIT storage + idempotency cache)
  - 📧 SMTP:          Resend with bellsuniversity.edu.ng custom domain (SPF/DKIM/DMARC)
  - 💳 Payments:      Paystack (primary) / ALAT Pay (WEMA Bank) — production API keys

---

## PHASE 0 — Procure VPS + DNS

- [ ] Buy a VPS at RackServe/HostAfrica/Hostnownow (Lagos/Ibadan): **4 vCPU / 8GB RAM / 100GB NVMe**, Ubuntu 22.04 LTS
- [ ] Assign IPv4 + note IP, e.g. `197.211.X.Y`
- [ ] In Bells University domain registrar (www.bellsuniversity.edu.ng):
  - [ ] Add **A record** `payment.bellsuniversity.edu.ng     → 197.211.X.Y`   (FRONTEND)
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

# UFW firewall — ONLY allow SSH, HTTP, HTTPS. MySQL (3306), Redis (6379), Node API (3001) NEVER exposed!
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

# ===== MySQL 8.0 =====
# (Ubuntu 22.04 ships MySQL 8.0 by default; no external PPA needed!
sudo apt install -y mysql-server mysql-client
sudo systemctl enable --now mysql

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

## PHASE 3 — MySQL + Redis Initial Setup (PRODUCTION-GRADE SECURITY)

```bash
# ===== MySQL 8.0 =====
# Post-install SECURE INSTALL wizard — run this BEFORE creating users/databases!
# Answer: Validate password component → Y (level MEDIUM or STRONG)
#         Remove anonymous users → Y
#         Disallow root login remotely → Y
#         Remove test DBs → Y
#         Reload privilege tables → Y
sudo mysql_secure_installation

# Create DB + user (as root). MySQL on Ubuntu authenticates root with auth_socket so no root pw.
sudo mysql

-- Inside mysql shell:
CREATE USER 'bells_payment_user'@'127.0.0.1' IDENTIFIED BY 'USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE';
CREATE DATABASE bells_payment_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON bells_payment_db.* TO 'bells_payment_user'@'127.0.0.1';
FLUSH PRIVILEGES;
\q

# === Harden MySQL ===
#   1) NO external bind-address. Only local socket/loopback!
sudo sed -i 's|^bind-address\s*=\s*127.0.0.1|bind-address = 127.0.0.1|g' /etc/mysql/mysql.conf.d/mysqld.cnf 2>/dev/null
sudo sed -i 's|^mysqlx-bind-address|#mysqlx-bind-address|g' /etc/mysql/mysql.conf.d/mysqld.cnf 2>/dev/null
#   2) Disable LOCAL INFILE (NDPR / CIS MySQL hardening).
sudo tee -a /etc/mysql/mysql.conf.d/mysqld.cnf >/dev/null <<'EOF'
[mysqld]
local_infile = 0
sql_require_primary_key = 1
EOF
sudo systemctl restart mysql
# Verify login works WITH password (no unix socket auth allowed for application user):
mysql -h 127.0.0.1 -u bells_payment_user -pUSE-LONG-RANDOM-128-CHAR-PASSWORD-HERE bells_payment_db -e "SELECT @@version;"

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

# === Populate api/.env with PRODUCTION values (COPY api/.env.example → .env AND FILL IN REAL SECRETS)
# CRITICAL: NEVER commit real secrets to git! NEVER use dev JWT_SECRET in prod!
cp api/.env.example api/.env
nano api/.env

# === Populate app/.env.local for frontend build (URL gets BAKED into JS at BUILD TIME!)
# Or just copy the template and edit later if the example default is correct.
cp app/.env.local.example app/.env.local
cat app/.env.local  # should contain: VITE_API_BASE_URL=https://paymentapi.bellsuniversity.edu.ng/api/v1

# === Run 1-click deploy ===
chmod +x deploy.sh
./deploy.sh
# Watch the output. Expected: "✅ DEPLOY COMPLETE" + API health HTTP 200.
# First deploy will also run: npx prisma migrate deploy
```

### Exact env vars to double-check in `api/.env`:
```
NODE_ENV=production
PORT=3001

# MySQL 8.0 Prisma DSN
# ⚠️ IF password contains '@ : / % ? space → must PERCENT-ENCODE. Use socket path for maximum security (no TCP auth).
# DATABASE_URL="mysql://bells_payment_user:PERCENT-ENCODED-STRONGPASSWORD@127.0.0.1:3306/bells_payment_db?socket=/var/run/mysqld/mysqld.sock"

JWT_SECRET=<openssl rand -hex 64>               # TWO DIFFERENT 128-char hex strings
JWT_REFRESH_SECRET=<openssl rand -hex 64>      #   ← different one!
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
ENCRYPTION_KEY=<openssl rand -hex 32>

REDIS_URL=redis://:REDIS-LONG-RANDOM-PASSWORD-64CHARS@127.0.0.1:6379/0

# PRODUCTION PUBLIC URLS — set these BEFORE first deploy!!!
APP_BASE_URL=https://paymentapi.bellsuniversity.edu.ng
PUBLIC_URL=https://payment.bellsuniversity.edu.ng
PUBLIC_API_URL=https://paymentapi.bellsuniversity.edu.ng/api/v1
FRONTEND_BASE_URL=https://payment.bellsuniversity.edu.ng
CORS_ORIGIN=https://payment.bellsuniversity.edu.ng
STUDENT_PORTAL_URL=https://payment.bellsuniversity.edu.ng/login
PAYSTACK_CALLBACK_URL=https://payment.bellsuniversity.edu.ng/student/dashboard

# PAYSTACK
PAYSTACK_SECRET_KEY=sk_live_xxx
PAYSTACK_PUBLIC_KEY=pk_live_xxx
PAYSTACK_WEBHOOK_SECRET=<copy from Paystack Webhook Dashboard Settings panel>

# ALAT Pay
ALATPAY_MODE=prod
ALATPAY_SECRET_KEY=...
ALATPAY_WEBHOOK_SECRET=...

# Resend
RESEND_API_KEY=re_xxx
EMAIL_FROM_ADDRESS=bursary@bellsuniversity.edu.ng

# Trust proxy = single nginx (TRUST_PROXY_HOPS=1 by default in .env.example already)
# IF Bells puts Cloudflare in front → increase to 2.
# TRUST_PROXY_HOPS=1
```

If deploy.sh succeeds →
  - React SPA built in `app/dist/` and rsync'd to `/var/www/payment.bellsuniversity.edu.ng/html/`
  - Node API running on 127.0.0.1:3001 via 2 PM2 cluster workers
  - `pm2 status` → `bells-api` is `online` both workers
  - `pm2 logs bells-api --lines 50` shows startup, no crashes on Prisma MySQL connect error 😎

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
sudo systemctl status certbot.timer   # auto-renewal active (2x/day)
```

## TEST SSL + CORS
```bash
# From ANY machine:
curl -I https://payment.bellsuniversity.edu.ng/             # HTTP 200 + Strict-Transport-Security header
curl -v https://paymentapi.bellsuniversity.edu.ng/api/v1/health   # HTTP 200 JSON success

# From the VPS itself (bypass nginx sanity):
curl -s http://127.0.0.1:3001/api/v1/health | jq .
```

---

## PHASE 6 — DNS Records for Email Deliverability (Resend)
Bells IT adds these 3 records to the bellsuniversity.edu.ng DNS zone in the registrar / cPanel:

| Type  | Host                          | Value                                                                     |
|-------|-------------------------------|---------------------------------------------------------------------------|
| CNAME | `bells-email`                 | `rs1.resend.net`                                                          |
| TXT   | `_dmarc.bells-email`          | `v=DMARC1; p=quarantine; rua=mailto:devops@bellsuniversity.edu.ng; fo=1;` |
| TXT   | `_dmarc` (or @ root)          | `v=DMARC1; p=none; rua=mailto:devops@bellsuniversity.edu.ng;`  → upgrade to p=reject after 2 weeks |

After adding → Verify DNS Records in Resend dashboard → wait until "Ready to send".

Test from VPS: `curl -X POST https://paymentapi.bellsuniversity.edu.ng/api/v1/auth/forgot-password ... and confirm email hits PRIMARY inbox, not Spam folder.

---

## PHASE 7 — Automated Backup (mysqldump + logs + branding uploads)

```bash
sudo tee /etc/cron.d/bells-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=devops@bellsuniversity.edu.ng

# Full MySQL DB every day at 2:15 AM. Keep the last 30 days.
# Note: MySQL 8 connection uses mysql_native_password; use the MySQL 8 bells_payment_user account with BACKUP_ADMIN privilege if set.
15 2 * * * deploy  MYSQL_PWD=USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE /usr/bin/mysqldump --single-transaction --routines --triggers --events -h 127.0.0.1 -u bells_payment_user bells_payment_db | gzip -c > /var/backups/bells-payment-db-$(date +\%F_\%H\%M).sql.gz ; find /var/backups -type f -name 'bells-payment-db-*.sql.gz' -mtime +30 -delete

# Weekly rotate PM2 logs
@weekly root  /usr/bin/su - deploy -c "pm2 flush" 2>&1 | logger -t bells-pm2-logrotate
EOF
sudo chmod 644 /etc/cron.d/bells-backup
sudo systemctl restart cron

# MANUAL TEST first-run:
sudo su - deploy -c 'MYSQL_PWD=USE-LONG-RANDOM-128-CHAR-PASSWORD-HERE mysqldump --single-transaction -h 127.0.0.1 -u bells_payment_user bells_payment_db | gzip -c > /tmp/test-backup.sql.gz && ls -lh /tmp/test-backup.sql.gz'
```

For OFF-SITE backup (fire, theft, ransomware): nightly rclone → Bells Google Workspace Shared Drive / Backblaze B2.

---

## PHASE 8 — Smoke Test Payment Gateway Webhooks BEFORE Go-Live

**In Paystack / ALAT Pay Production Dashboards:**
- [ ] Set Paystack webhook URL to `https://paymentapi.bellsuniversity.edu.ng/api/v1/webhooks/paystack`
- [ ] Set ALAT Pay webhook URL to `https://paymentapi.bellsuniversity.edu.ng/api/v1/webhooks/alatpay`
- [ ] Use Paystack Test Mode → create a ₦100 invoice for student `student1@university.edu.ng`
- [ ] Simulate payment via test card → verify:
    - [ ] Paystack webhook arrives at API (`pm2 logs bells-api`)
    - [ ] Receipt PDF downloads from `/admin/receipts` with watermark + correct
    - [ ] Confirmation email lands in test student PRIMARY inbox
    - [ ] Student dashboard shows invoice as PAID
    - [ ] QR code on PDF encodes payment.bellsuniversity.edu.ng/public/verify-receipt/... URL NOT localhost

---

## PHASE 9 — Go-Live

- [ ] Login as **admin@university.edu.ng / admin123 → FORCE password change immediately (ForcePasswordChangeGate forces this!)
- [ ] Create initial bursary users: `finance@bellsuniversity.edu.ng`
- [ ] Upload first academic session + faculties/colleges/departments via Bulk CSV Import
- [ ] Import first-year student data via Bulk XLSX
- [ ] Publish fees catalogue + do a small pilot with 10 students
- [ ] After pilot OK → announce portal to students!

---

## PHASE 10 — Day-2 Operations Runbook (keep at hand)

| Task | Command |
|---|---|
| Deploy new code | `cd /var/www/bells-payment && ./deploy.sh` |
| Check API health | `curl https://paymentapi.bellsuniversity.edu.ng/api/v1/health \| jq .` |
| View live logs | `pm2 logs bells-api --lines 100` |
| Reload API | `pm2 reload bells-api --update-env` |
| Stop API | `pm2 stop bells-api` |
| MySQL status | `sudo systemctl status mysql` |
| Redis status   | `sudo systemctl status redis-server` |
| Disk free      | `df -h /` — alert if >75% |
| Nginx reload   | `sudo nginx -t && sudo systemctl reload nginx` |
| Certbot dry-run | `sudo certbot renew --dry-run` |
| Security updates | `sudo apt update && sudo unattended-upgrade --dry-run -d` |
| Monthly backup restore test (NDPR audit!) | Restore last .sql.gz → new test DB; run `npx prisma validate` against restored DB schema |

---

## 🔐 CRITICAL REMINDERS

1. **api/.env, app/.env.local** are IN .gitignore. NEVER `git add api/.env`. NEVER commit a production secret to a public/private GitHub repo.
2. Every 90 days: rotate JWT secrets, MySQL bells_payment_user password, Redis password, Resend API keys.
3. Production DB migrations always run: `npx prisma migrate deploy` (NOT `db push` — dev-only!). NEVER run `prisma migrate dev` or `db push` in prod.
4. The portal code already implements OWASP Session-1 (SQLi, CSP, CSV formula magic bytes) + Session-2 (15min JWT + rotating refresh tokens). Keep NODE_ENV=production so Express error middleware never returns source-code stack traces!
5. When in doubt about any step → ping the Bursary Payment Portal dev team first.
