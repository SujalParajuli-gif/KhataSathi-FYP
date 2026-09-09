#!/bin/sh
set -eu

install -d -o node -g node -m 0755 \
  /uploads \
  /uploads/products \
  /document-storage \
  /document-storage/.temp \
  /document-storage/documents \
  /document-storage/import-sources \
  /backups

# Validate actual file creation as the runtime user. Merely having a writable
# Docker mount is insufficient when an existing volume has the wrong owner.
gosu node sh -eu -c '
  for directory in /uploads /document-storage/.temp /document-storage/documents /document-storage/import-sources; do
    probe="$directory/.entrypoint-write-$$"
    : > "$probe"
    rm -f "$probe"
  done
'

echo "Applying pending Prisma migrations..."
gosu node ./node_modules/.bin/prisma migrate deploy

exec gosu node "$@"
