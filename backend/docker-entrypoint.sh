#!/bin/sh
set -eu

mkdir -p /uploads /document-storage /backups
chown -R node:node /uploads /document-storage /backups

echo "Applying pending Prisma migrations..."
gosu node ./node_modules/.bin/prisma migrate deploy

exec gosu node "$@"
