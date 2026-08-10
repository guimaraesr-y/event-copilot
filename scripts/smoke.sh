#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUTBOX_WAIT_SECONDS="${OUTBOX_WAIT_SECONDS:-20}"

printf '1/13 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/13 install and publish n8n gateway... '
./scripts/n8n-sync.sh >/dev/null
echo OK

printf '3/13 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" -H 'content-type: application/json' -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo 'could not extract organization id'; exit 1; }
echo "$ORG_ID"

printf '4/13 create wedding template... '
TEMPLATE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/event-templates" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Casamento Padrão Smoke","eventType":"wedding"}')
TEMPLATE_ID=$(printf '%s' "$TEMPLATE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$TEMPLATE_ID" ] || { echo 'could not extract template id'; exit 1; }
echo "$TEMPLATE_ID"

printf '5/13 add template plan... '
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Fechar RSVP","offsetDays":-30,"dueTime":"09:00","priority":"high","type":"guest"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Confirmar fornecedores","offsetDays":-7,"dueTime":"10:00","priority":"critical","type":"confirmation"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/milestones" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Checklist final","offsetDays":-1,"dueTime":"18:00"}' >/dev/null
echo OK

printf '6/13 create event from template... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ana & Pedro\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-17T17:30:00-03:00\",\"guestCount\":132}")
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo 'could not extract event id'; exit 1; }
echo "$EVENT_ID"

printf '7/13 verify event plan regression... '
TASKS_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H "x-organization-id: $ORG_ID")
printf '%s' "$TASKS_JSON" | grep -q '2026-09-17T12:00:00.000Z' || { echo 'D-30 date mismatch'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-10-10T13:00:00.000Z' || { echo 'D-7 date mismatch'; exit 1; }
echo OK

printf '8/13 create vendor catalog entry... '
VENDOR_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Luz Foto","category":"photo","contactName":"Carla","phone":"+5521999999999","email":"foto@example.com"}')
VENDOR_ID=$(printf '%s' "$VENDOR_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$VENDOR_ID" ] || { echo 'could not extract vendor id'; exit 1; }
echo "$VENDOR_ID"

printf '9/13 attach vendor to event... '
ASSIGNMENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\",\"contractStatus\":\"signed\",\"paymentStatus\":\"partial\"}")
ASSIGNMENT_ID=$(printf '%s' "$ASSIGNMENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ASSIGNMENT_ID" ] || { echo 'could not extract event vendor id'; exit 1; }
printf '%s' "$ASSIGNMENT_JSON" | grep -q '"confirmationStatus":"pending"' || { echo 'initial confirmation state mismatch'; exit 1; }
printf '%s' "$ASSIGNMENT_JSON" | grep -q '"vendorName":"Luz Foto"' || { echo 'vendor snapshot missing'; exit 1; }
echo "$ASSIGNMENT_ID"

printf '10/13 request vendor confirmation... '
REQUEST_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"deadlineAt":"2026-10-10T09:00:00-03:00"}')
printf '%s' "$REQUEST_JSON" | grep -q '"confirmationStatus":"requested"' || { echo 'confirmation request state mismatch'; exit 1; }
echo OK

printf '11/13 verify n8n prepared vendor confirmation action... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  ACTION_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM automation_actions a JOIN outbox_events o ON o.id=a.source_outbox_event_id WHERE o.aggregate_id='$ASSIGNMENT_ID'::uuid AND o.event_type='vendor.confirmation_requested' AND o.dispatched_at IS NOT NULL AND a.action_type='vendor_confirmation.prepare' AND a.status='prepared';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$ACTION_COUNT" = '1' ]; then
    echo OK
    break
  fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${ACTION_COUNT:-0}" = '1' ] || { echo 'n8n did not prepare exactly one vendor confirmation action'; exit 1; }

printf '12/13 record vendor confirmation... '
CONFIRM_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirm" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"arrivalAt":"2026-10-17T14:30:00-03:00","teamSize":4}')
printf '%s' "$CONFIRM_JSON" | grep -q '"confirmationStatus":"confirmed"' || { echo 'confirmation state mismatch'; exit 1; }
printf '%s' "$CONFIRM_JSON" | grep -q '"teamSize":4' || { echo 'confirmed team size missing'; exit 1; }
printf '%s' "$CONFIRM_JSON" | grep -q '2026-10-17T17:30:00.000Z' || { echo 'arrival timestamp mismatch'; exit 1; }
echo OK

printf '13/13 verify n8n acknowledged all event/vendor domain events... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  EVENT_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE aggregate_id = '$EVENT_ID'::uuid AND event_type IN ('event.created','event.plan_initialized') AND dispatched_at IS NOT NULL;\"" 2>/dev/null | tr -d '\r[:space:]')
  VENDOR_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE aggregate_id = '$ASSIGNMENT_ID'::uuid AND event_type IN ('vendor.attached','vendor.confirmation_requested','vendor.confirmed') AND dispatched_at IS NOT NULL;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$EVENT_COUNT" = '2' ] && [ "$VENDOR_COUNT" = '3' ]; then
    echo OK
    echo 'Smoke test passed.'
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done

echo "domain events were not fully acknowledged by n8n after ${OUTBOX_WAIT_SECONDS}s"
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT id,event_type,aggregate_id,attempts,claimed_by,dispatched_at,last_error FROM outbox_events WHERE aggregate_id IN ('$EVENT_ID'::uuid,'$ASSIGNMENT_ID'::uuid) ORDER BY created_at;\"" || true
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT * FROM automation_actions WHERE aggregate_id='$ASSIGNMENT_ID'::uuid ORDER BY created_at;\"" || true
exit 1
