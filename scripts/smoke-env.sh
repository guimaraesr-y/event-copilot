#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="${SMOKE_ENV_FILE:-$ROOT_DIR/.env.smoke}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Smoke env file not found: $ENV_FILE" >&2
  exit 1
fi

# Export every value so nested scripts that call plain `docker compose`
# cannot accidentally fall back to the developer's normal .env.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

case "${COMPOSE_PROJECT_NAME:-}" in
  *smoke*) ;;
  *)
    echo "Refusing to run: COMPOSE_PROJECT_NAME must contain 'smoke'." >&2
    exit 1
    ;;
esac

if [ "${WHATSAPP_PROVIDER:-}" != "mock" ]; then
  echo "Refusing to run: smoke environment must use WHATSAPP_PROVIDER=mock." >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Smoke project : $COMPOSE_PROJECT_NAME"
echo "Smoke gateway : $BASE_URL"
echo "Messaging     : $WHATSAPP_PROVIDER"

# A dedicated smoke project makes destructive reset safe and deterministic.
# Set SMOKE_RESET=0 to preserve the previous smoke database/n8n volume.
if [ "${SMOKE_RESET:-1}" = "1" ]; then
  echo "Resetting dedicated smoke volumes..."
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
fi

echo "Starting smoke stack..."
docker compose up --build -d

echo "Waiting for API readiness..."
attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl -fsS "$BASE_URL/api/health/ready" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if ! curl -fsS "$BASE_URL/api/health/ready" >/dev/null 2>&1; then
  echo "Smoke stack did not become ready." >&2
  docker compose ps || true
  docker compose logs --tail=120 api postgres n8n worker gateway || true
  exit 1
fi

exec ./scripts/smoke.sh
