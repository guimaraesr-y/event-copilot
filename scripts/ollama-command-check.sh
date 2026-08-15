#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

./scripts/ollama-setup.sh

echo "Building API image used by the live interpreter check..."
docker compose build api >/dev/null

echo "Running live Ollama command interpretation scenarios..."
docker compose --profile ai run --rm --no-deps \
  api bun validation/ollama-live/command-interpreter-live.ts
