#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$API_DIR/storage/backups"
LOG_DIR="$API_DIR/storage/logs"
LOG_FILE="$LOG_DIR/backup.log"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

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

TIMESTAMP="$(date +%Y%m%d-%H%M)"
OUTPUT_FILE="$BACKUP_DIR/university-wallet-${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] Starting backup of $DB_NAME -> $OUTPUT_FILE"

MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --databases "$DB_NAME" \
  | gzip > "$OUTPUT_FILE"

chmod 600 "$OUTPUT_FILE"

LINE_COUNT="$(zcat "$OUTPUT_FILE" | wc -l | tr -d ' ')"
FILE_SIZE="$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || stat -f%z "$OUTPUT_FILE" 2>/dev/null || echo 0)"

if [ "$LINE_COUNT" -eq 0 ]; then
  echo "[$(date -Iseconds)] BACKUP FAILED — dump is empty (0 lines). File: $OUTPUT_FILE" | tee -a "$LOG_FILE"
  rm -f "$OUTPUT_FILE"
  exit 1
fi

find "$BACKUP_DIR" -name "university-wallet-*.sql.gz" -type f -mtime +30 -delete

echo "[$(date -Iseconds)] BACKUP OK size=${FILE_SIZE}B lines=${LINE_COUNT} file=$(basename "$OUTPUT_FILE")" | tee -a "$LOG_FILE"
