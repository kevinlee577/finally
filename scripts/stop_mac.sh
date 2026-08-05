#!/usr/bin/env bash
#
# FinAlly — stop and remove the app container (macOS / Linux).
# See planning/PLAN.md §11. Idempotent: safe to run when nothing is running.
#
# The SQLite database lives in the bind-mounted db/ directory on the host and
# is NOT touched by this script — your portfolio survives a stop/start cycle.
#
set -euo pipefail

CONTAINER_NAME="finally"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not on PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running — nothing to stop."
  exit 0
fi

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "==> Stopping and removing container '$CONTAINER_NAME'..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
  echo "Stopped. Database preserved in ./db (delete db/finally.db to reset)."
else
  echo "Container '$CONTAINER_NAME' is not present — nothing to stop."
fi
