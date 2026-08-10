#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUTBOX_WAIT_SECONDS="${OUTBOX_WAIT_SECONDS:-30}"

post_provider_status() {
  external_id="$1"
  status="$2"
  docker compose exec -T -e ECC_EXTERNAL_ID="$external_id" -e ECC_STATUS="$status" api bun -e '
    import { createHmac } from "node:crypto";
    const stable = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
    const payload = { provider: "mock", externalMessageId: process.env.ECC_EXTERNAL_ID, status: process.env.ECC_STATUS, occurredAt: new Date().toISOString() };
    const timestamp = String(Math.floor(Date.now()/1000));
    const secret = process.env.MESSAGING_WEBHOOK_SHARED_SECRET;
    const signature = createHmac("sha256", secret).update(`${timestamp}.${stable(payload)}`).digest("hex");
    const response = await fetch("http://n8n:5678/webhook/ecc-whatsapp-status", { method: "POST", headers: { "content-type": "application/json", "x-ecc-timestamp": timestamp, "x-ecc-signature": `sha256=${signature}` }, body: JSON.stringify(payload) });
    if (!response.ok) { console.error(await response.text()); process.exit(1); }
  ' >/dev/null
}

printf '1/18 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/18 install and publish n8n workflows... '
./scripts/n8n-sync.sh >/dev/null
echo OK

printf '3/18 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" -H 'content-type: application/json' -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo 'could not extract organization id'; exit 1; }
echo "$ORG_ID"

printf '4/18 create wedding template... '
TEMPLATE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/event-templates" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Casamento Padrão Smoke","eventType":"wedding"}')
TEMPLATE_ID=$(printf '%s' "$TEMPLATE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$TEMPLATE_ID" ] || { echo 'could not extract template id'; exit 1; }
echo "$TEMPLATE_ID"

printf '5/18 add template plan... '
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Fechar RSVP","offsetDays":-30,"dueTime":"09:00","priority":"high","type":"guest"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Confirmar fornecedores","offsetDays":-7,"dueTime":"10:00","priority":"critical","type":"confirmation"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/milestones" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Checklist final","offsetDays":-1,"dueTime":"18:00"}' >/dev/null
echo OK

printf '6/18 create event from template... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ana & Pedro\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-17T17:30:00-03:00\",\"guestCount\":132}")
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo 'could not extract event id'; exit 1; }
echo "$EVENT_ID"

printf '7/18 verify event plan regression... '
TASKS_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H "x-organization-id: $ORG_ID")
printf '%s' "$TASKS_JSON" | grep -q '2026-09-17T12:00:00.000Z' || { echo 'D-30 date mismatch'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-10-10T13:00:00.000Z' || { echo 'D-7 date mismatch'; exit 1; }
echo OK

printf '8/18 create vendor catalog entry... '
VENDOR_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Luz Foto","category":"photo","contactName":"Carla","phone":"+5521999999999","email":"foto@example.com"}')
VENDOR_ID=$(printf '%s' "$VENDOR_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$VENDOR_ID" ] || { echo 'could not extract vendor id'; exit 1; }
echo "$VENDOR_ID"

printf '9/18 attach vendor to event... '
ASSIGNMENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\",\"contractStatus\":\"signed\",\"paymentStatus\":\"partial\"}")
ASSIGNMENT_ID=$(printf '%s' "$ASSIGNMENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ASSIGNMENT_ID" ] || { echo 'could not extract event vendor id'; exit 1; }
echo "$ASSIGNMENT_ID"

printf '10/18 request vendor confirmation... '
REQUEST_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"deadlineAt":"2026-10-10T09:00:00-03:00"}')
printf '%s' "$REQUEST_JSON" | grep -q '"confirmationStatus":"requested"' || { echo 'confirmation request state mismatch'; exit 1; }
echo OK

printf '11/18 verify n8n created and sent one outbound message... '
ATTEMPT=0
MESSAGE_ROW=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  MESSAGE_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT m.id,m.external_message_id,m.status,a.status FROM outbound_messages m JOIN automation_actions a ON a.id=m.source_action_id WHERE m.aggregate_id='$ASSIGNMENT_ID'::uuid AND m.message_type='vendor_confirmation';\"" 2>/dev/null | tr -d '\r')
  if printf '%s' "$MESSAGE_ROW" | grep -q '|sent|completed$'; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$MESSAGE_ROW" | grep -q '|sent|completed$' || { echo 'outbound message was not sent by mock provider'; exit 1; }
MESSAGE_ID=$(printf '%s' "$MESSAGE_ROW" | cut -d'|' -f1)
EXTERNAL_ID=$(printf '%s' "$MESSAGE_ROW" | cut -d'|' -f2)

printf '12/18 verify outbound idempotency... '
MESSAGE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE aggregate_id='$ASSIGNMENT_ID'::uuid AND message_type='vendor_confirmation';\"" | tr -d '\r[:space:]')
[ "$MESSAGE_COUNT" = '1' ] || { echo "expected 1 outbound message, got $MESSAGE_COUNT"; exit 1; }
echo OK

printf '13/18 simulate provider delivered status through n8n... '
post_provider_status "$EXTERNAL_ID" delivered
echo OK

printf '14/18 verify delivered tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'delivered' ] || { echo "expected delivered, got $STATUS"; exit 1; }
echo OK

printf '15/18 simulate provider read status through n8n... '
post_provider_status "$EXTERNAL_ID" read
echo OK

printf '16/18 verify read tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'read' ] || { echo "expected read, got $STATUS"; exit 1; }
echo OK

printf '17/18 preserve vendor confirmation regression... '
CONFIRM_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirm" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"arrivalAt":"2026-10-17T14:30:00-03:00","teamSize":4}')
printf '%s' "$CONFIRM_JSON" | grep -q '"confirmationStatus":"confirmed"' || { echo 'confirmation state mismatch'; exit 1; }
echo OK

printf '18/18 verify all generated domain events were acknowledged... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  PENDING=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE organization_id='$ORG_ID'::uuid AND dispatched_at IS NULL;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$PENDING" = '0' ]; then echo OK; echo 'Smoke test passed.'; exit 0; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done

echo "outbox still has pending events after ${OUTBOX_WAIT_SECONDS}s"
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT id,event_type,aggregate_id,attempts,dispatched_at,last_error FROM outbox_events WHERE organization_id='$ORG_ID'::uuid ORDER BY created_at;\"" || true
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT * FROM outbound_messages WHERE organization_id='$ORG_ID'::uuid ORDER BY created_at;\"" || true
exit 1
