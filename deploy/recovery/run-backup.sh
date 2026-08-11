#!/bin/sh
set -eu

umask 077

STATUS_ROOT=${BACKUP_STATUS_ROOT:-/status}
STATUS_FILE="$STATUS_ROOT/last-recovery-backup.json"
LOCK_DIR="$STATUS_ROOT/.recovery-backup.lock"
PAYLOAD_WORK_DIR=/payload/backup/current
BACKUP_HOST=${RESTIC_BACKUP_HOST:-khatasathi-vps}
KEEP_DAILY=${RESTIC_KEEP_DAILY:-14}
KEEP_WEEKLY=${RESTIC_KEEP_WEEKLY:-8}
KEEP_MONTHLY=${RESTIC_KEEP_MONTHLY:-6}
AUTO_INIT=${RESTIC_AUTO_INIT:-false}
APP_COMMIT=${KHATASATHI_APP_COMMIT:-unknown}
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CURRENT_STAGE=initializing
COMPLETED=0

require_value() {
  variable_name=$1
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "Required recovery setting is missing: $variable_name" >&2
    exit 1
  fi
}

require_positive_integer() {
  variable_name=$1
  eval "variable_value=\${$variable_name:-}"
  case "$variable_value" in
    ''|*[!0-9]*) echo "$variable_name must be a positive integer." >&2; exit 1 ;;
    0) echo "$variable_name must be greater than zero." >&2; exit 1 ;;
  esac
}

write_status() {
  state=$1
  stage=$2
  completed_at=${3:-}
  snapshot_id=${4:-}
  total_files=${5:-0}
  total_bytes=${6:-0}
  data_added=${7:-0}
  retention_applied=${8:-false}
  status_tmp="$STATUS_FILE.tmp.$$"

  jq -n \
    --arg status "$state" \
    --arg stage "$stage" \
    --arg startedAt "$STARTED_AT" \
    --arg completedAt "$completed_at" \
    --arg snapshotId "$snapshot_id" \
    --arg appCommit "$APP_COMMIT" \
    --arg backupHost "$BACKUP_HOST" \
    --argjson totalFiles "$total_files" \
    --argjson totalBytes "$total_bytes" \
    --argjson dataAdded "$data_added" \
    --argjson retentionApplied "$retention_applied" \
    '{
      schemaVersion: 1,
      status: $status,
      stage: $stage,
      startedAt: $startedAt,
      completedAt: (if $completedAt == "" then null else $completedAt end),
      snapshotId: (if $snapshotId == "" then null else $snapshotId end),
      appCommit: $appCommit,
      backupHost: $backupHost,
      totalFilesProcessed: $totalFiles,
      totalBytesProcessed: $totalBytes,
      dataAdded: $dataAdded,
      retentionApplied: $retentionApplied,
      contents: ["database", "uploads", "documents"]
    }' > "$status_tmp"
  chmod 0644 "$status_tmp"
  mv "$status_tmp" "$STATUS_FILE"
}

cleanup() {
  exit_code=$?
  rm -rf -- "$PAYLOAD_WORK_DIR"
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
  if [ "$exit_code" -ne 0 ] && [ "$COMPLETED" -ne 1 ]; then
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    write_status FAILED "$CURRENT_STAGE" "$completed_at" || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_value RESTIC_REPOSITORY
require_value RESTIC_PASSWORD_FILE
require_value DB_NAME
require_value DB_USER
require_value DB_PASSWORD
require_positive_integer RESTIC_KEEP_DAILY
require_positive_integer RESTIC_KEEP_WEEKLY
require_positive_integer RESTIC_KEEP_MONTHLY

if [ ! -s "$RESTIC_PASSWORD_FILE" ]; then
  echo "The Restic password file is missing or empty." >&2
  exit 1
fi

mkdir -p "$STATUS_ROOT" /payload/backup
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another full recovery backup is already running." >&2
  exit 1
fi
write_status RUNNING "$CURRENT_STAGE"

CURRENT_STAGE=repository
if ! restic snapshots --json >/tmp/restic-snapshots.json 2>/tmp/restic-repository-error.log; then
  if [ "$AUTO_INIT" != "true" ]; then
    echo "Restic repository is unavailable or not initialized." >&2
    exit 1
  fi
  echo "Initializing the configured Restic repository..."
  restic init
fi

CURRENT_STAGE=database_dump
rm -rf -- "$PAYLOAD_WORK_DIR"
mkdir -p "$PAYLOAD_WORK_DIR"
echo "Creating a transaction-consistent MySQL dump..."
MYSQL_PWD=$DB_PASSWORD mysqldump \
  --host=mysql \
  --port=3306 \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --skip-lock-tables \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  --hex-blob \
  --triggers \
  "$DB_NAME" > "$PAYLOAD_WORK_DIR/database.sql"

if [ ! -s "$PAYLOAD_WORK_DIR/database.sql" ]; then
  echo "MySQL dump was created but is empty." >&2
  exit 1
fi

UPLOAD_FILE_COUNT=$(find /payload/uploads -type f | wc -l | tr -d ' ')
DOCUMENT_FILE_COUNT=$(find /payload/documents -type f | wc -l | tr -d ' ')
DATABASE_BYTES=$(wc -c < "$PAYLOAD_WORK_DIR/database.sql" | tr -d ' ')

jq -n \
  --arg createdAt "$STARTED_AT" \
  --arg applicationCommit "$APP_COMMIT" \
  --arg database "$DB_NAME" \
  --argjson uploadFiles "$UPLOAD_FILE_COUNT" \
  --argjson documentFiles "$DOCUMENT_FILE_COUNT" \
  --argjson databaseBytes "$DATABASE_BYTES" \
  '{
    schemaVersion: 1,
    createdAt: $createdAt,
    applicationCommit: $applicationCommit,
    database: $database,
    consistency: { database: "transaction-consistent", files: "captured during snapshot scan" },
    contents: {
      databaseDump: "backup/current/database.sql",
      uploads: "uploads",
      documents: "documents"
    },
    sourceCounts: {
      uploadFiles: $uploadFiles,
      documentFiles: $documentFiles,
      databaseBytes: $databaseBytes
    }
  }' > "$PAYLOAD_WORK_DIR/manifest.json"

CURRENT_STAGE=snapshot
echo "Creating a deduplicated full recovery snapshot..."
restic backup \
  --json \
  --host "$BACKUP_HOST" \
  --tag khatasathi \
  --tag full-recovery \
  /payload > /tmp/restic-backup.json

SNAPSHOT_ID=$(jq -r 'select(.message_type == "summary") | .snapshot_id // empty' /tmp/restic-backup.json | tail -n 1)
TOTAL_FILES=$(jq -r 'select(.message_type == "summary") | .total_files_processed // 0' /tmp/restic-backup.json | tail -n 1)
TOTAL_BYTES=$(jq -r 'select(.message_type == "summary") | .total_bytes_processed // 0' /tmp/restic-backup.json | tail -n 1)
DATA_ADDED=$(jq -r 'select(.message_type == "summary") | .data_added // 0' /tmp/restic-backup.json | tail -n 1)

if [ -z "$SNAPSHOT_ID" ]; then
  echo "Restic completed without returning a snapshot identifier." >&2
  exit 1
fi

CURRENT_STAGE=retention
RETENTION_APPLIED=false
if restic forget \
  --host "$BACKUP_HOST" \
  --tag full-recovery \
  --keep-daily "$KEEP_DAILY" \
  --keep-weekly "$KEEP_WEEKLY" \
  --keep-monthly "$KEEP_MONTHLY" \
  --prune; then
  RETENTION_APPLIED=true
else
  echo "Warning: snapshot succeeded, but retention cleanup needs attention." >&2
fi

COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
write_status SUCCESS complete "$COMPLETED_AT" "$SNAPSHOT_ID" "$TOTAL_FILES" "$TOTAL_BYTES" "$DATA_ADDED" "$RETENTION_APPLIED"
COMPLETED=1
echo "Full recovery backup completed: snapshot $SNAPSHOT_ID"
