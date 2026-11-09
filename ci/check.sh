#!/usr/bin/env bash
# Single entry point for all repo checks; used locally and by CI.
# Set SKIP_INTEGRATION=1 to skip the integration suite (e.g. when Docker is unavailable).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> lint"
pnpm lint

echo "==> typecheck"
pnpm typecheck

echo "==> unit tests"
pnpm test

if [[ "${SKIP_INTEGRATION:-0}" == "1" ]]; then
  echo "==> integration tests (skipped: SKIP_INTEGRATION=1)"
else
  echo "==> integration tests"
  pnpm test:integration
fi

echo "All checks passed."
