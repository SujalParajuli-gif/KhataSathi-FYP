#!/bin/sh
set -eu

umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=${KHATASATHI_PROJECT_DIR:-$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)}
COMPOSE_FILE=${KHATASATHI_COMPOSE_FILE:-$PROJECT_DIR/compose.production.yml}
ENV_FILE=${KHATASATHI_ENV_FILE:-$PROJECT_DIR/deploy/production.env}
REQUESTED_SNAPSHOT=${1:-latest}

if [ ! -f "$COMPOSE_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "Compose file or production environment file is missing." >&2
  exit 1
fi
for command_name in docker jq od tr; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

compose() {
  docker compose \
    --project-directory "$PROJECT_DIR" \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}

restic_command() {
  compose run --rm --no-deps --entrypoint restic recovery "$@"
}

if [ "$REQUESTED_SNAPSHOT" = "latest" ]; then
  SNAPSHOT_JSON=$(restic_command snapshots --json --tag full-recovery)
  SNAPSHOT_ID=$(printf '%s' "$SNAPSHOT_JSON" | jq -r 'sort_by(.time) | last | .id // empty')
else
  case "$REQUESTED_SNAPSHOT" in
    *[!0-9a-fA-F]*)
      echo "Snapshot must be 'latest' or a hexadecimal Restic snapshot ID." >&2
      exit 1
      ;;
  esac
  SNAPSHOT_ID=$REQUESTED_SNAPSHOT
fi

if [ -z "$SNAPSHOT_ID" ]; then
  echo "No full recovery snapshot is available for verification." >&2
  exit 1
fi

WORK_DIR=$(mktemp -d)
CONTAINER_NAME="khatasathi-restore-check-$$"
VOLUME_NAME="khatasathi_restore_check_$$"
ROOT_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Checking repository metadata before restore..."
restic_command check

echo "Restoring snapshot $SNAPSHOT_ID into an isolated temporary directory..."
compose run --rm --no-deps \
  --volume "$WORK_DIR:/restore" \
  --entrypoint restic \
  recovery restore "$SNAPSHOT_ID" --target /restore

PAYLOAD_DIR="$WORK_DIR/payload"
DATABASE_DUMP="$PAYLOAD_DIR/backup/current/database.sql"
MANIFEST="$PAYLOAD_DIR/backup/current/manifest.json"
UPLOADS_DIR="$PAYLOAD_DIR/uploads"
DOCUMENTS_DIR="$PAYLOAD_DIR/documents"

if [ ! -s "$DATABASE_DUMP" ] || [ ! -s "$MANIFEST" ]; then
  echo "Restore verification failed: database dump or manifest is missing." >&2
  exit 1
fi
if [ ! -d "$UPLOADS_DIR" ] || [ ! -d "$DOCUMENTS_DIR" ]; then
  echo "Restore verification failed: uploads or document storage is missing." >&2
  exit 1
fi
jq -e '.schemaVersion == 1 and .contents.databaseDump == "backup/current/database.sql"' "$MANIFEST" >/dev/null

EXPECTED_UPLOADS=$(jq -r '.sourceCounts.uploadFiles' "$MANIFEST")
EXPECTED_DOCUMENTS=$(jq -r '.sourceCounts.documentFiles' "$MANIFEST")
RESTORED_UPLOADS=$(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ')
RESTORED_DOCUMENTS=$(find "$DOCUMENTS_DIR" -type f | wc -l | tr -d ' ')
if [ "$RESTORED_UPLOADS" -ne "$EXPECTED_UPLOADS" ] || [ "$RESTORED_DOCUMENTS" -ne "$EXPECTED_DOCUMENTS" ]; then
  echo "Restore verification failed: restored file counts do not match the snapshot manifest." >&2
  exit 1
fi

docker volume create "$VOLUME_NAME" >/dev/null
docker run -d --name "$CONTAINER_NAME" \
  --volume "$VOLUME_NAME:/var/lib/mysql" \
  --env MYSQL_ROOT_PASSWORD="$ROOT_PASSWORD" \
  --env MYSQL_DATABASE=khatasathi_restore \
  mysql:8.4 >/dev/null

echo "Waiting for the isolated restore database..."
attempt=0
until docker exec "$CONTAINER_NAME" mysqladmin ping \
  --host=127.0.0.1 --user=root --password="$ROOT_PASSWORD" --silent >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Restore database did not become healthy within 60 seconds." >&2
    exit 1
  fi
  sleep 1
done

docker exec -i "$CONTAINER_NAME" mysql \
  --user=root --password="$ROOT_PASSWORD" khatasathi_restore < "$DATABASE_DUMP"

TABLE_COUNT=$(docker exec "$CONTAINER_NAME" mysql \
  --batch --skip-column-names --user=root --password="$ROOT_PASSWORD" \
  --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='khatasathi_restore';")
CRITICAL_TABLE_COUNT=$(docker exec "$CONTAINER_NAME" mysql \
  --batch --skip-column-names --user=root --password="$ROOT_PASSWORD" \
  --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='khatasathi_restore' AND table_name IN ('User','Product','Document');")

if [ "$TABLE_COUNT" -lt 1 ] || [ "$CRITICAL_TABLE_COUNT" -ne 3 ]; then
  echo "Restore verification failed: required database tables are missing." >&2
  exit 1
fi

echo "Restore verification passed without touching live data:"
echo "- Snapshot: $SNAPSHOT_ID"
echo "- Database tables: $TABLE_COUNT (all critical tables present)"
echo "- Upload files: $RESTORED_UPLOADS"
echo "- Document files: $RESTORED_DOCUMENTS"
