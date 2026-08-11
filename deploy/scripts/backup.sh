#!/bin/sh
set -eu

umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=${KHATASATHI_PROJECT_DIR:-$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)}
COMPOSE_FILE=${KHATASATHI_COMPOSE_FILE:-$PROJECT_DIR/compose.production.yml}
ENV_FILE=${KHATASATHI_ENV_FILE:-$PROJECT_DIR/deploy/production.env}

if [ ! -f "$COMPOSE_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "Compose file or production environment file is missing." >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || {
  echo "Docker is required to run the recovery backup service." >&2
  exit 1
}

APP_COMMIT=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')

echo "Starting the isolated KhataSathi full recovery backup..."
docker compose \
  --project-directory "$PROJECT_DIR" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  run --rm \
  -e "KHATASATHI_APP_COMMIT=$APP_COMMIT" \
  recovery

echo "The full recovery snapshot includes MySQL, uploads, and protected documents."
