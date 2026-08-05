#!/usr/bin/env bash
# Run the FinAlly E2E suite (PLAN.md §12) on macOS/Linux.
# Idempotent: always tears the stack down afterwards, including the tmpfs DB.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.test.yml"

cleanup() {
  echo "Tearing down E2E stack..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$REPO_ROOT"

echo "Starting E2E stack (app + Playwright)..."
docker compose -f "$COMPOSE_FILE" up --build \
  --abort-on-container-exit --exit-code-from playwright
TEST_EXIT_CODE=$?

if [ "$TEST_EXIT_CODE" -eq 0 ]; then
  echo "E2E suite passed."
else
  echo "E2E suite failed (exit code $TEST_EXIT_CODE)."
  echo "HTML report: $SCRIPT_DIR/playwright-report"
fi

exit "$TEST_EXIT_CODE"
