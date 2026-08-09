#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUTBOX_WAIT_SECONDS="${OUTBOX_WAIT_SECONDS:-10}"

printf '1/5 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/5 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" \
  -H 'content-type: application/json' \
  -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo "could not extract organization id"; exit 1; }
echo "$ORG_ID"

printf '3/5 create event... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" \
  -H 'content-type: application/json' \
  -H "x-organization-id: $ORG_ID" \
  -d '{"name":"Ana & Pedro","type":"wedding","startAt":"2026-10-17T17:30:00-03:00","guestCount":132,"venueName":"Casa do Lago"}')
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo "could not extract event id"; exit 1; }
echo "$EVENT_ID"

printf '4/5 read event... '
curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID" -H "x-organization-id: $ORG_ID" >/dev/null
echo OK

printf '5/5 verify worker consumed event.created... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DISPATCHED=$(docker compose exec -T postgres sh -c \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT CASE WHEN EXISTS (SELECT 1 FROM outbox_events WHERE event_type = 'event.created' AND aggregate_id = '$EVENT_ID'::uuid AND dispatched_at IS NOT NULL) THEN 'yes' ELSE 'no' END;\"" \
    2>/dev/null | tr -d '\r[:space:]')

  if [ "$DISPATCHED" = "yes" ]; then
    echo OK
    echo 'Smoke test passed.'
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

echo "event.created was not marked as dispatched after ${OUTBOX_WAIT_SECONDS}s"
echo 'Current outbox row:'
docker compose exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT id, event_type, aggregate_id, attempts, claimed_by, claimed_at, dispatched_at, last_error FROM outbox_events WHERE event_type = 'event.created' AND aggregate_id = '$EVENT_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" \
  || true
exit 1