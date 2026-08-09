#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUTBOX_WAIT_SECONDS="${OUTBOX_WAIT_SECONDS:-10}"

printf '1/8 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/8 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" \
  -H 'content-type: application/json' \
  -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo "could not extract organization id"; exit 1; }
echo "$ORG_ID"

printf '3/8 create wedding template... '
TEMPLATE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/event-templates" \
  -H 'content-type: application/json' \
  -H "x-organization-id: $ORG_ID" \
  -d '{"name":"Casamento Padrão Smoke","eventType":"wedding","description":"Plano operacional do smoke test"}')
TEMPLATE_ID=$(printf '%s' "$TEMPLATE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$TEMPLATE_ID" ] || { echo "could not extract template id"; exit 1; }
echo "$TEMPLATE_ID"

printf '4/8 add template tasks and milestone... '
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" \
  -H 'content-type: application/json' \
  -H "x-organization-id: $ORG_ID" \
  -d '{"title":"Fechar RSVP","offsetDays":-30,"dueTime":"09:00","priority":"high","type":"guest","sortOrder":10}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" \
  -H 'content-type: application/json' \
  -H "x-organization-id: $ORG_ID" \
  -d '{"title":"Confirmar fornecedores","offsetDays":-7,"dueTime":"10:00","priority":"critical","type":"confirmation","sortOrder":20}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/milestones" \
  -H 'content-type: application/json' \
  -H "x-organization-id: $ORG_ID" \
  -d '{"name":"Checklist final","offsetDays":-1,"dueTime":"18:00","sortOrder":10}' >/dev/null
echo OK

printf '5/8 create event from template... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" \
  -H 'content-type: application/json' \
  -H "x-organization-id: $ORG_ID" \
  -d "{\"name\":\"Ana & Pedro\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-17T17:30:00-03:00\",\"guestCount\":132,\"venueName\":\"Casa do Lago\"}")
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo "could not extract event id"; exit 1; }
echo "$EVENT_ID"

printf '6/8 verify instantiated tasks and timezone dates... '
TASKS_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H "x-organization-id: $ORG_ID")
printf '%s' "$TASKS_JSON" | grep -q '"source":"template"' || { echo 'template source missing'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-09-17T12:00:00.000Z' || { echo 'D-30 RSVP date mismatch'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-10-10T13:00:00.000Z' || { echo 'D-7 vendor date mismatch'; exit 1; }
echo OK

printf '7/8 verify milestone and event traceability... '
MILESTONES_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/milestones" -H "x-organization-id: $ORG_ID")
printf '%s' "$MILESTONES_JSON" | grep -q '2026-10-16T21:00:00.000Z' || { echo 'D-1 milestone date mismatch'; exit 1; }
printf '%s' "$EVENT_JSON" | grep -q "\"templateId\":\"$TEMPLATE_ID\"" || { echo 'event template traceability missing'; exit 1; }
echo OK

printf '8/8 verify worker consumed event domain events... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DISPATCHED_COUNT=$(docker compose exec -T postgres sh -c \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE aggregate_id = '$EVENT_ID'::uuid AND event_type IN ('event.created', 'event.plan_initialized') AND dispatched_at IS NOT NULL;\"" \
    2>/dev/null | tr -d '\r[:space:]')

  if [ "$DISPATCHED_COUNT" = "2" ]; then
    echo OK
    echo 'Smoke test passed.'
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

echo "event domain events were not both dispatched after ${OUTBOX_WAIT_SECONDS}s"
echo 'Current outbox rows:'
docker compose exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT id, event_type, aggregate_id, attempts, claimed_by, claimed_at, dispatched_at, last_error FROM outbox_events WHERE aggregate_id = '$EVENT_ID'::uuid ORDER BY created_at;\"" \
  || true
exit 1
