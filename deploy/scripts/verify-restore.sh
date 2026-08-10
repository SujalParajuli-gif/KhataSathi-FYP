#!/bin/sh
set -eu

umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /absolute/path/to/khatasathi-backup.tar.gz[.age]" >&2
  exit 1
fi

ARCHIVE=$1
if [ ! -f "$ARCHIVE" ]; then
  echo "Backup archive not found: $ARCHIVE" >&2
  exit 1
fi

for command_name in docker tar gzip sha256sum od tr; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

WORK_DIR=$(mktemp -d)
CONTAINER_NAME="khatasathi-restore-check-$$"
VOLUME_NAME="khatasathi_restore_check_$$"
ROOT_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
RESTORE_ARCHIVE=$ARCHIVE

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT INT TERM

case "$ARCHIVE" in
  *.age)
    command -v age >/dev/null 2>&1 || {
      echo "An encrypted backup requires the age command." >&2
      exit 1
    }
    if [ -z "${BACKUP_AGE_IDENTITY:-}" ]; then
      echo "Set BACKUP_AGE_IDENTITY to the private age identity file." >&2
      exit 1
    fi
    RESTORE_ARCHIVE="$WORK_DIR/decrypted.tar.gz"
    age --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "$RESTORE_ARCHIVE" "$ARCHIVE"
    ;;
esac

tar -xzf "$RESTORE_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR"
  sha256sum -c SHA256SUMS
  gzip -t database.sql.gz
  tar -tzf uploads.tar.gz >/dev/null
  tar -tzf document-storage.tar.gz >/dev/null
)

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

gzip -dc "$WORK_DIR/database.sql.gz" | docker exec -i "$CONTAINER_NAME" \
  mysql --user=root --password="$ROOT_PASSWORD" khatasathi_restore

TABLE_COUNT=$(docker exec "$CONTAINER_NAME" mysql \
  --batch --skip-column-names --user=root --password="$ROOT_PASSWORD" \
  --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='khatasathi_restore';")

if [ "$TABLE_COUNT" -lt 1 ]; then
  echo "Restore verification failed: the restored database contains no tables." >&2
  exit 1
fi

echo "Restore verification passed: $TABLE_COUNT database tables plus valid file archives."
