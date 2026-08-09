#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"

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
if docker compose logs worker | grep -q 'event.created'; then
  echo OK
else
  echo 'worker did not log event.created'
  exit 1
fi

echo 'Smoke test passed.'
