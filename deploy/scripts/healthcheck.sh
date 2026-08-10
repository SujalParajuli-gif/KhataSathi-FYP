#!/bin/sh
set -eu

ORIGIN=${1:-${APP_ORIGIN:-}}
if [ -z "$ORIGIN" ]; then
  echo "Usage: $0 https://app.example.com" >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || {
  echo "curl is required." >&2
  exit 1
}

ORIGIN=${ORIGIN%/}
curl --fail --silent --show-error --max-time 10 "$ORIGIN/api/health"
printf '\nKhataSathi health check passed for %s\n' "$ORIGIN"
