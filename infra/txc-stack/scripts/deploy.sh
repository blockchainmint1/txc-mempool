#!/usr/bin/env bash
# Update the running stack from the txc-mempool git repo.
#
# Layout this assumes on the server:
#   /opt/txc-mempool   <- git clone of the txc-mempool repo (code, disposable)
#   /opt/txc-stack     <- the RUNNING stack (data/ + .env live here, never touched)
#
# One-time setup (as root):
#   git clone <YOUR_REPO_URL> /opt/txc-mempool
#
# Then to deploy any change:
#   bash /opt/txc-mempool/infra/txc-stack/scripts/deploy.sh [service ...]
#
# With no arguments it rebuilds/recreates everything that changed.
set -euo pipefail

SRC="${SRC:-/opt/txc-mempool}"
DST="${DST:-/opt/txc-stack}"

echo "==> pulling latest code in $SRC"
git -C "$SRC" pull --ff-only

echo "==> syncing stack files into $DST (data/ and .env preserved)"
rsync -a --delete \
  --exclude 'data/' \
  --exclude '.env' \
  "$SRC/infra/txc-stack/" "$DST/"

cd "$DST"

if [ "$#" -gt 0 ]; then
  echo "==> rebuilding: $*"
  docker compose build "$@"
  docker compose up -d --force-recreate "$@"
else
  echo "==> rebuilding all services"
  docker compose build
  docker compose up -d
fi

echo "==> current state"
docker compose ps
