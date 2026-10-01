#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 /path/to/university-wallet-YYYYMMDD-HHMM.sql.gz"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: File not found: $BACKUP_FILE"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")"

ENV_FILE="$API_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

prompt_if_empty() {
  local varname="$1"
  local prompt="$2"
  if [ -z "${!varname:-}" ]; then
    read -rp "$prompt" "$varname"
  fi
}

prompt_if_empty DB_HOST     "Enter DB_HOST: "
prompt_if_empty DB_PORT     "Enter DB_PORT [3306]: "
prompt_if_empty DB_USER     "Enter DB_USER: "
prompt_if_empty DB_PASSWORD "Enter DB_PASSWORD: "
prompt_if_empty DB_NAME     "Enter DB_NAME: "

DB_PORT="${DB_PORT:-3306}"

echo ""
echo "=============================================="
echo "  DANGER: DATABASE RESTORE"
echo "=============================================="
echo "  Database : $DB_NAME"
echo "  Host     : $DB_HOST:$DB_PORT"
echo "  Backup   : $BACKUP_FILE"
echo ""
echo "  This will DROP and OVERWRITE all tables in"
echo "  database '$DB_NAME'."
echo ""
echo "  Type YES in 3 capital letters to PROCEED."
echo "  Type anything else to CANCEL."
echo "=============================================="
read -rp "Confirm: " CONFIRM

if [ "$CONFIRM" != "YES" ]; then
  echo "Restore CANCELLED by user."
  exit 0
fi

echo "Restoring... (dropping existing tables and importing from backup)"

DROP_AND_CREATE="DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\`;"
MYSQL_PWD="$DB_PASSWORD" mysql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --force=false \
  --unbuffered \
  -e "$DROP_AND_CREATE"

zcat "$BACKUP_FILE" | MYSQL_PWD="$DB_PASSWORD" mysql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --force=false \
  --unbuffered \
  "$DB_NAME"

echo ""
echo "Restore completed successfully for database '$DB_NAME'."
