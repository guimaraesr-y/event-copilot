#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

# Use the same .env resolution as Compose. Explicit shell variables still win.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

COMMAND_MODEL="${OLLAMA_COMMAND_MODEL:-qwen3:4b}"
AGENT_MODEL="${OLLAMA_AGENT_MODEL:-$COMMAND_MODEL}"

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

pull_model() {
  model="$1"
  label="$2"
  echo "Pulling configured $label model..."
  echo "Model: $model"
  docker compose --profile ai exec -T ollama ollama pull "$model"
}

pull_model "$COMMAND_MODEL" "command"
if [ "$AGENT_MODEL" != "$COMMAND_MODEL" ]; then
  pull_model "$AGENT_MODEL" "operational agent"
else
  echo "Operational Agent reuses command model: $AGENT_MODEL"
fi

echo "Ollama models are ready"
