#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required on the host to run the Ollama command benchmark." >&2
  exit 1
fi

./scripts/ollama-setup.sh

echo "Resolving Ollama host endpoint..."
OLLAMA_HOST_ENDPOINT=$(docker compose --profile ai port ollama 11434 | head -n 1 | tr -d '\r')
if [ -z "$OLLAMA_HOST_ENDPOINT" ]; then
  echo "Could not resolve the published Ollama port." >&2
  exit 1
fi

# docker compose port may return 0.0.0.0:<port> in some environments.
# The compose file currently binds Ollama to 127.0.0.1, but normalize anyway.
case "$OLLAMA_HOST_ENDPOINT" in
  0.0.0.0:*) OLLAMA_HOST_ENDPOINT="127.0.0.1:${OLLAMA_HOST_ENDPOINT#*:}" ;;
esac

OLLAMA_HOST_BASE_URL="http://$OLLAMA_HOST_ENDPOINT"
OLLAMA_CONFIGURED_MODEL=$(docker compose --profile ai exec -T ollama sh -lc 'printf "%s" "$OLLAMA_COMMAND_MODEL"' | tr -d '\r')
if [ -z "$OLLAMA_CONFIGURED_MODEL" ]; then
  OLLAMA_CONFIGURED_MODEL="qwen3:4b"
fi

echo "Running live Ollama command interpretation scenarios on the host..."
echo "Ollama : $OLLAMA_HOST_BASE_URL"
echo "Model  : $OLLAMA_CONFIGURED_MODEL"

# The live benchmark runs on the developer machine, while only Ollama lives in Docker.
# This lets Bun import the project's validation/ and packages/ directories directly.
OLLAMA_BASE_URL="$OLLAMA_HOST_BASE_URL" \
OLLAMA_COMMAND_MODEL="$OLLAMA_CONFIGURED_MODEL" \
OLLAMA_COMMAND_TIMEOUT_MS="${OLLAMA_COMMAND_TIMEOUT_MS:-120000}" \
OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}" \
bun validation/ollama-live/command-interpreter-live.ts
