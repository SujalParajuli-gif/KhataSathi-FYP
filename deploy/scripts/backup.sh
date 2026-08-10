#!/bin/sh
set -eu

umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
COMPOSE_FILE=${KHATASATHI_COMPOSE_FILE:-$PROJECT_DIR/compose.production.yml}
ENV_FILE=${KHATASATHI_ENV_FILE:-$PROJECT_DIR/deploy/production.env}
BACKUP_DIR=${KHATASATHI_BACKUP_DIR:-/var/backups/khatasathi}
AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT:-}
RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE:-}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
APP_COMMIT=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')

case "$BACKUP_DIR" in
  /*) ;;
  *) echo "KHATASATHI_BACKUP_DIR must be an absolute path." >&2; exit 1 ;;
esac
if [ "$BACKUP_DIR" = "/" ]; then
  echo "Refusing to use / as the backup directory." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "Compose file or production environment file is missing." >&2
  exit 1
fi

for command_name in docker tar gzip sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"
LOCK_DIR="$BACKUP_DIR/.backup.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another KhataSathi backup is already running." >&2
  exit 1
fi
WORK_DIR=
ARCHIVE_TMP=
ENCRYPTED_TMP=
cleanup() {
  [ -z "$WORK_DIR" ] || rm -rf -- "$WORK_DIR"
  [ -z "$ARCHIVE_TMP" ] || rm -f -- "$ARCHIVE_TMP"
  [ -z "$ENCRYPTED_TMP" ] || rm -f -- "$ENCRYPTED_TMP"
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
WORK_DIR=$(mktemp -d "$BACKUP_DIR/.working-$STAMP-XXXXXX")

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "Creating a transaction-consistent MySQL dump..."
compose exec -T mysql sh -c \
  'exec mysqldump --single-transaction --quick --skip-lock-tables --no-tablespaces --routines --triggers --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  > "$WORK_DIR/database.sql"
gzip -9 "$WORK_DIR/database.sql"

echo "Archiving product/profile uploads and business documents..."
docker run --rm \
  --volume khatasathi_uploads:/source:ro \
  --volume "$WORK_DIR:/backup" \
  alpine:3.23 tar -czf /backup/uploads.tar.gz -C /source .
docker run --rm \
  --volume khatasathi_document_storage:/source:ro \
  --volume "$WORK_DIR:/backup" \
  alpine:3.23 tar -czf /backup/document-storage.tar.gz -C /source .

cat > "$WORK_DIR/backup-metadata.txt" <<EOF
created_utc=$STAMP
application_commit=$APP_COMMIT
compose_project=khatasathi
database_image=mysql:8.4
contents=database,uploads,document-storage
EOF

(
  cd "$WORK_DIR"
  sha256sum database.sql.gz uploads.tar.gz document-storage.tar.gz backup-metadata.txt > SHA256SUMS
)

ARCHIVE="$BACKUP_DIR/daily/khatasathi-$STAMP.tar.gz"
ARCHIVE_TMP="$BACKUP_DIR/.khatasathi-$STAMP.tar.gz.tmp"
tar -czf "$ARCHIVE_TMP" -C "$WORK_DIR" \
  database.sql.gz uploads.tar.gz document-storage.tar.gz backup-metadata.txt SHA256SUMS
mv "$ARCHIVE_TMP" "$ARCHIVE"

if [ -n "$AGE_RECIPIENT" ]; then
  command -v age >/dev/null 2>&1 || {
    echo "BACKUP_AGE_RECIPIENT is set but age is not installed." >&2
    exit 1
  }
  ENCRYPTED_TMP="$ARCHIVE.age.tmp"
  age --recipient "$AGE_RECIPIENT" --output "$ENCRYPTED_TMP" "$ARCHIVE"
  mv "$ENCRYPTED_TMP" "$ARCHIVE.age"
  ENCRYPTED_TMP=
  rm -f -- "$ARCHIVE"
  ARCHIVE="$ARCHIVE.age"
fi

# Keep independent retention links without duplicating data on the same filesystem.
DAY_OF_WEEK=$(date +%u)
DAY_OF_MONTH=$(date +%d)
if [ "$DAY_OF_WEEK" = "7" ]; then
  ln "$ARCHIVE" "$BACKUP_DIR/weekly/$(basename "$ARCHIVE")"
fi
if [ "$DAY_OF_MONTH" = "01" ]; then
  ln "$ARCHIVE" "$BACKUP_DIR/monthly/$(basename "$ARCHIVE")"
fi

find "$BACKUP_DIR/daily" -type f -mtime +14 -delete
find "$BACKUP_DIR/weekly" -type f -mtime +56 -delete
find "$BACKUP_DIR/monthly" -type f -mtime +186 -delete

if [ -n "$RCLONE_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || {
    echo "BACKUP_RCLONE_REMOTE is set but rclone is not installed." >&2
    exit 1
  }
  rclone copyto "$ARCHIVE" "${RCLONE_REMOTE%/}/$(basename "$ARCHIVE")"
fi

echo "Backup completed: $ARCHIVE"
