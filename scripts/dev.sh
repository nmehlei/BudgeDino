#!/usr/bin/env bash
# Local dev entry: `scripts/dev.sh server` or `scripts/dev.sh seed [--with-data]`.
# Loads .env.dev (or .env.dev.example), creates the gitignored dev master key on first use and runs the
# server / the dev seed through tsx. Development only: never use this on a real deployment.
set -euo pipefail

cd "$(dirname "$0")/.."

mode="${1:-}"
[[ $# -gt 0 ]] && shift
# `pnpm dev:seed -- --with-data` may forward the separator.
[[ "${1:-}" == "--" ]] && shift

# Check the caller's NODE_ENV before the env file is read, so nothing can mask it.
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "scripts/dev.sh refuses to run with NODE_ENV=production" >&2
  exit 2
fi

env_file=.env.dev
[[ -f "$env_file" ]] || env_file=.env.dev.example
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

# The env file must not decide this: dev scripts always run as development.
export NODE_ENV=development

if [[ -z "${BUDGEDINO_MASTER_KEY:-}" && -z "${BUDGEDINO_MASTER_KEY_FILE:-}" ]]; then
  key_file=.dev/master.key
  if [[ ! -s "$key_file" ]]; then
    mkdir -p .dev
    (umask 077 && openssl rand -base64 32 >"$key_file")
    echo "Generated a dev master key at $key_file (gitignored). Keep it: the dev database is unreadable without it." >&2
  fi
  export BUDGEDINO_MASTER_KEY_FILE="$PWD/$key_file"
fi

case "$mode" in
  server)
    if [[ "${HOST:-0.0.0.0}" == "0.0.0.0" ]]; then
      echo "WARNING: the dev server listens on ALL network interfaces (HOST=0.0.0.0) with fixed demo credentials." >&2
      echo "         Use it on a trusted Wi-Fi only, stop it when done, never expose or port-forward it." >&2
      echo "         HOST=127.0.0.1 pnpm dev:server keeps it local (the phone then cannot reach it)." >&2
    fi
    exec pnpm exec tsx src/server/src/main.ts
    ;;
  seed)
    exec pnpm exec tsx src/server/src/cli.ts dev-seed "$@"
    ;;
  *)
    echo "Usage: scripts/dev.sh server | seed [--with-data]" >&2
    exit 2
    ;;
esac
