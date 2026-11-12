#!/usr/bin/env bash
# Single entry point for all repo checks; used locally and by CI.
# Set SKIP_INTEGRATION=1 to skip the Docker-based suites (integration, e2e, build smoke tests).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> lint"
pnpm lint
pnpm exec prettier --check .

echo "==> typecheck"
pnpm typecheck

echo "==> unit tests"
pnpm test

echo "==> mobile (lint, typecheck, jest; no Android build in CI)"
pnpm mobile:lint
pnpm mobile:typecheck
pnpm mobile:test

echo "==> build"
pnpm build

echo "==> openapi drift"
node scripts/generate-openapi.mjs
if ! git diff --exit-code -- docs/api/openapi.json; then
  echo "docs/api/openapi.json is out of date: run 'pnpm openapi' and commit the result." >&2
  exit 1
fi
if [[ -n "$(git ls-files --others --exclude-standard -- docs/api/openapi.json)" ]]; then
  echo "docs/api/openapi.json is not committed: run 'pnpm openapi' and commit it." >&2
  exit 1
fi

if [[ "${SKIP_INTEGRATION:-0}" == "1" ]]; then
  echo "==> integration, e2e and build smoke tests (skipped: SKIP_INTEGRATION=1)"
else
  echo "==> integration tests"
  pnpm test:integration

  echo "==> e2e tests"
  pnpm test:e2e

  echo "==> build smoke tests (dist with plain Node)"
  pnpm exec vitest run --project build
fi

echo "All checks passed."
