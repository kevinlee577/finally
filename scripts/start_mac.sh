#!/usr/bin/env bash
#
# FinAlly — start the app container (macOS / Linux).
# See planning/PLAN.md §11. Idempotent: safe to run repeatedly.
#
#   ./scripts/start_mac.sh              # build if needed, then run
#   ./scripts/start_mac.sh --build      # force a rebuild first
#   ./scripts/start_mac.sh --no-browser # don't open a browser window
#
set -euo pipefail

IMAGE_NAME="finally"
CONTAINER_NAME="finally"
HOST_PORT="${FINALLY_PORT:-8000}"
HEALTH_TIMEOUT=90

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

force_build=0
open_browser=1

for arg in "$@"; do
  case "$arg" in
    --build)      force_build=1 ;;
    --no-browser) open_browser=0 ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "start_mac.sh: unknown option '$arg' (try --help)" >&2
      exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not on PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: the Docker daemon is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

# Bind-mount target for the SQLite file. Created here so a fresh clone works.
mkdir -p "$REPO_ROOT/db"

if [ "$force_build" -eq 1 ] || ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "==> Building image '$IMAGE_NAME' (this takes a few minutes the first time)..."
  docker build -t "$IMAGE_NAME" "$REPO_ROOT"
else
  echo "==> Image '$IMAGE_NAME' already exists (use --build to rebuild)."
fi

# Idempotency: replace any previous container of this name. The database lives
# in the bind-mounted db/ directory, so nothing is lost by recreating it.
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "==> Removing existing container '$CONTAINER_NAME'..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# .env is passed at run time and never baked into the image.
env_args=()
if [ -f "$REPO_ROOT/.env" ]; then
  env_args+=(--env-file "$REPO_ROOT/.env")
else
  echo "WARNING: no .env found at $REPO_ROOT/.env — copy .env.example to .env and add your" >&2
  echo "         OPENROUTER_API_KEY. The app will still start, but AI chat will be disabled." >&2
fi

echo "==> Starting container '$CONTAINER_NAME' on port $HOST_PORT..."
# Note: ${env_args[@]+...} keeps this working with bash 3.2 (macOS default),
# where expanding an empty array under `set -u` is an error.
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "${HOST_PORT}:8000" \
  -v "$REPO_ROOT/db:/app/db" \
  ${env_args[@]+"${env_args[@]}"} \
  "$IMAGE_NAME" >/dev/null

url="http://localhost:${HOST_PORT}"

echo "==> Waiting for the app to become healthy..."
healthy=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fsS "${url}/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  # Surface a crash immediately instead of waiting out the full timeout.
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" != "true" ]; then
    echo "ERROR: the container exited during startup. Recent logs:" >&2
    docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 1
done

if [ "$healthy" -ne 1 ]; then
  echo "ERROR: /api/health did not respond within ${HEALTH_TIMEOUT}s. Recent logs:" >&2
  docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
  exit 1
fi

echo
echo "  FinAlly is running:  $url"
echo "  Logs:                docker logs -f $CONTAINER_NAME"
echo "  Stop:                ./scripts/stop_mac.sh"
echo

if [ "$open_browser" -eq 1 ]; then
  if command -v open >/dev/null 2>&1; then
    open "$url" || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
fi
