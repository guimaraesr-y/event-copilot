#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

echo "Starting Ollama service..."
docker compose --profile ai up -d ollama

echo "Waiting for Ollama readiness..."
attempt=0
while [ "$attempt" -lt 60 ]; do
  if docker compose --profile ai exec -T ollama ollama list >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if ! docker compose --profile ai exec -T ollama ollama list >/dev/null 2>&1; then
  echo "Ollama did not become ready." >&2
  docker compose --profile ai logs --tail=100 ollama >&2 || true
  exit 1
fi

echo "Pulling configured command model..."
docker compose --profile ai exec -T ollama sh -lc 'echo "Model: $OLLAMA_COMMAND_MODEL"; ollama pull "$OLLAMA_COMMAND_MODEL"'
echo "Ollama model is ready"
