#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUTBOX_WAIT_SECONDS="${OUTBOX_WAIT_SECONDS:-30}"

post_mock_provider_status() {
  external_id="$1"
  status="$2"
  occurred_at="$3"

  docker compose exec -T \
    -e ECC_EXTERNAL_ID="$external_id" \
    -e ECC_STATUS="$status" \
    -e ECC_OCCURRED_AT="$occurred_at" \
    api bun -e '
      import { createHmac } from "node:crypto";
      const payload = {
        externalMessageId: process.env.ECC_EXTERNAL_ID,
        status: process.env.ECC_STATUS,
        occurredAt: process.env.ECC_OCCURRED_AT,
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const secret = process.env.MESSAGING_WEBHOOK_SHARED_SECRET;
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");

      const response = await fetch("http://api:3000/api/v1/messaging/webhooks/mock", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ecc-timestamp": timestamp,
          "x-ecc-signature": `sha256=${signature}`,
        },
        body: rawBody,
      });
      if (!response.ok) {
        console.error(await response.text());
        process.exit(1);
      }
    ' >/dev/null
}

post_mock_inbound_message() {
  external_id="$1"
  sender="$2"
  text="$3"
  occurred_at="$4"

  docker compose exec -T \
    -e ECC_EXTERNAL_ID="$external_id" \
    -e ECC_SENDER="$sender" \
    -e ECC_TEXT="$text" \
    -e ECC_OCCURRED_AT="$occurred_at" \
    api bun -e '
      import { createHmac } from "node:crypto";
      const payload = {
        type: "message.received",
        externalMessageId: process.env.ECC_EXTERNAL_ID,
        sender: process.env.ECC_SENDER,
        recipient: "5521888888888",
        occurredAt: process.env.ECC_OCCURRED_AT,
        content: { type: "text", text: process.env.ECC_TEXT },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const secret = process.env.MESSAGING_WEBHOOK_SHARED_SECRET;
      const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
      const response = await fetch("http://api:3000/api/v1/messaging/webhooks/mock", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ecc-timestamp": timestamp,
          "x-ecc-signature": `sha256=${signature}`,
        },
        body: rawBody,
      });
      if (!response.ok) { console.error(await response.text()); process.exit(1); }
    ' >/dev/null
}

printf '1/38 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/38 install and publish n8n workflow... '
./scripts/n8n-sync.sh >/dev/null
echo OK

printf '3/38 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" -H 'content-type: application/json' -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo 'could not extract organization id'; exit 1; }
echo "$ORG_ID"

printf '4/38 create wedding template... '
TEMPLATE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/event-templates" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Casamento Padrão Smoke","eventType":"wedding"}')
TEMPLATE_ID=$(printf '%s' "$TEMPLATE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$TEMPLATE_ID" ] || { echo 'could not extract template id'; exit 1; }
echo "$TEMPLATE_ID"

printf '5/38 add template plan... '
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Fechar RSVP","offsetDays":-30,"dueTime":"09:00","priority":"high","type":"guest"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Confirmar fornecedores","offsetDays":-7,"dueTime":"10:00","priority":"critical","type":"confirmation"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/milestones" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Checklist final","offsetDays":-1,"dueTime":"18:00"}' >/dev/null
echo OK

printf '6/38 create event from template... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ana & Pedro\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-17T17:30:00-03:00\",\"guestCount\":132}")
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo 'could not extract event id'; exit 1; }
echo "$EVENT_ID"

printf '7/38 verify event plan regression... '
TASKS_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H "x-organization-id: $ORG_ID")
printf '%s' "$TASKS_JSON" | grep -q '2026-09-17T12:00:00.000Z' || { echo 'D-30 date mismatch'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-10-10T13:00:00.000Z' || { echo 'D-7 date mismatch'; exit 1; }
echo OK

printf '8/38 create vendor catalog entry... '
VENDOR_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Luz Foto","category":"photo","contactName":"Carla","phone":"+5521999999999","email":"foto@example.com"}')
VENDOR_ID=$(printf '%s' "$VENDOR_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$VENDOR_ID" ] || { echo 'could not extract vendor id'; exit 1; }
echo "$VENDOR_ID"

printf '9/38 attach vendor to event... '
ASSIGNMENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\",\"contractStatus\":\"signed\",\"paymentStatus\":\"partial\"}")
ASSIGNMENT_ID=$(printf '%s' "$ASSIGNMENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ASSIGNMENT_ID" ] || { echo 'could not extract event vendor id'; exit 1; }
echo "$ASSIGNMENT_ID"

printf '10/38 request vendor confirmation... '
REQUEST_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"deadlineAt":"2026-10-10T09:00:00-03:00"}')
printf '%s' "$REQUEST_JSON" | grep -q '"confirmationStatus":"requested"' || { echo 'confirmation request state mismatch'; exit 1; }
echo OK

printf '11/38 verify n8n created and sent one outbound message... '
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

printf '12/38 verify outbound idempotency... '
MESSAGE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE aggregate_id='$ASSIGNMENT_ID'::uuid AND message_type='vendor_confirmation';\"" | tr -d '\r[:space:]')
[ "$MESSAGE_COUNT" = '1' ] || { echo "expected 1 outbound message, got $MESSAGE_COUNT"; exit 1; }
echo OK

DELIVERED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
READ_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

printf '13/38 simulate delivered through generic messaging webhook... '
post_mock_provider_status "$EXTERNAL_ID" delivered "$DELIVERED_AT"
echo OK

printf '14/38 verify delivered tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'delivered' ] || { echo "expected delivered, got $STATUS"; exit 1; }
echo OK

printf '15/38 simulate read through generic messaging webhook... '
post_mock_provider_status "$EXTERNAL_ID" read "$READ_AT"
echo OK

printf '16/38 verify read tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'read' ] || { echo "expected read, got $STATUS"; exit 1; }
echo OK

printf '17/38 verify provider webhook idempotency... '
post_mock_provider_status "$EXTERNAL_ID" read "$READ_AT"
WEBHOOK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM messaging_webhook_events WHERE provider='mock' AND external_event_id='mock:$EXTERNAL_ID:read:$READ_AT';\"" | tr -d '\r[:space:]')
[ "$WEBHOOK_COUNT" = '1' ] || { echo "expected one canonical webhook receipt, got $WEBHOOK_COUNT"; exit 1; }
echo OK

printf '18/38 simulate supplier inbound confirmation... '
INBOUND_EXTERNAL_ID="mock-inbound-$ASSIGNMENT_ID"
# Keep the simulated reply strictly after the outbound send timestamp.
sleep 1
INBOUND_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
post_mock_inbound_message "$INBOUND_EXTERNAL_ID" '5521999999999' 'Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.' "$INBOUND_AT"
echo OK

printf '19/38 verify inbound message persisted and correlated... '
ATTEMPT=0
INBOUND_ROW=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  INBOUND_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,status,resolved_event_vendor_id FROM inbound_messages WHERE provider='mock' AND external_message_id='$INBOUND_EXTERNAL_ID';\"" 2>/dev/null | tr -d '\r')
  if printf '%s' "$INBOUND_ROW" | grep -q "|processed|$ASSIGNMENT_ID$"; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$INBOUND_ROW" | grep -q "|processed|$ASSIGNMENT_ID$" || { echo "inbound message was not processed: $INBOUND_ROW"; exit 1; }
INBOUND_ID=$(printf '%s' "$INBOUND_ROW" | cut -d'|' -f1)

printf '20/38 verify supplier response updated vendor assignment... '
VENDOR_STATE=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT confirmation_status,(arrival_at = '2026-10-17T17:30:00Z'::timestamptz),team_size FROM event_vendors WHERE id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$VENDOR_STATE" | grep -q '^confirmed|t|3$' || { echo "unexpected vendor state: $VENDOR_STATE"; exit 1; }
echo OK

printf '21/38 verify inbound webhook/process idempotency... '
post_mock_inbound_message "$INBOUND_EXTERNAL_ID" '5521999999999' 'Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.' "$INBOUND_AT"
INBOUND_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbound_messages WHERE provider='mock' AND external_message_id='$INBOUND_EXTERNAL_ID';\"" | tr -d '\r[:space:]')
CONFIRMED_EVENTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE organization_id='$ORG_ID'::uuid AND event_type='vendor.confirmed' AND aggregate_id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$INBOUND_COUNT" = '1' ] || { echo "expected one inbound message, got $INBOUND_COUNT"; exit 1; }
[ "$CONFIRMED_EVENTS" = '1' ] || { echo "expected one vendor.confirmed event, got $CONFIRMED_EVENTS"; exit 1; }
echo OK

printf '22/38 verify event activity timeline... '
ATTEMPT=0
ACTIVITY_JSON=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  ACTIVITY_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/activity" -H "x-organization-id: $ORG_ID")
  if printf '%s' "$ACTIVITY_JSON" | grep -q 'vendor.confirmed' && printf '%s' "$ACTIVITY_JSON" | grep -q 'message.received'; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$ACTIVITY_JSON" | grep -q 'vendor.confirmed' || { echo 'vendor.confirmed missing from activity timeline'; exit 1; }
printf '%s' "$ACTIVITY_JSON" | grep -q 'message.received' || { echo 'message.received missing from activity timeline'; exit 1; }

printf '23/38 verify activity projection idempotency... '
CONFIRMED_ACTIVITY_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action='vendor.confirmed';\"" | tr -d '\r[:space:]')
[ "$CONFIRMED_ACTIVITY_COUNT" = '1' ] || { echo "expected one vendor.confirmed activity, got $CONFIRMED_ACTIVITY_COUNT"; exit 1; }
echo OK

printf '24/38 create two pending confirmation contexts for ambiguity... '
EVENT2_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ambiguous A\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-18T17:30:00-03:00\",\"guestCount\":80}")
EVENT2_ID=$(printf '%s' "$EVENT2_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
EVENT3_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ambiguous B\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-19T17:30:00-03:00\",\"guestCount\":90}")
EVENT3_ID=$(printf '%s' "$EVENT3_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
ASSIGN2_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT2_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\"}")
ASSIGN2_ID=$(printf '%s' "$ASSIGN2_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
ASSIGN3_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT3_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\"}")
ASSIGN3_ID=$(printf '%s' "$ASSIGN3_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT2_ID/vendors/$ASSIGN2_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT3_ID/vendors/$ASSIGN3_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{}' >/dev/null
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  SENT_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE aggregate_id IN ('$ASSIGN2_ID'::uuid,'$ASSIGN3_ID'::uuid) AND status IN ('sent','delivered','read');\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$SENT_COUNT" = '2' ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${SENT_COUNT:-0}" = '2' ] || { echo 'ambiguous outbound confirmations were not sent'; exit 1; }

printf '25/38 simulate ambiguous supplier response... '
AMBIGUOUS_EXTERNAL_ID="mock-ambiguous-$ORG_ID"
sleep 1
AMBIGUOUS_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
post_mock_inbound_message "$AMBIGUOUS_EXTERNAL_ID" '5521999999999' 'Sim, confirmado.' "$AMBIGUOUS_AT"
ATTEMPT=0
AMBIGUOUS_INBOUND_ID=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  AMBIGUOUS_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,status FROM inbound_messages WHERE provider='mock' AND external_message_id='$AMBIGUOUS_EXTERNAL_ID';\"" 2>/dev/null | tr -d '\r')
  if printf '%s' "$AMBIGUOUS_ROW" | grep -q '|needs_review$'; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "${AMBIGUOUS_ROW:-}" | grep -q '|needs_review$' || { echo "ambiguous inbound was not held for review: ${AMBIGUOUS_ROW:-}"; exit 1; }
AMBIGUOUS_INBOUND_ID=$(printf '%s' "$AMBIGUOUS_ROW" | cut -d'|' -f1)

printf '26/38 verify operational inbox item... '
ATTEMPT=0
INBOX_JSON=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  INBOX_JSON=$(curl -fsS "$BASE_URL/api/v1/inbox?status=open" -H "x-organization-id: $ORG_ID")
  if printf '%s' "$INBOX_JSON" | grep -q 'inbound_message_review' && printf '%s' "$INBOX_JSON" | grep -q "$AMBIGUOUS_INBOUND_ID"; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$INBOX_JSON" | grep -q 'inbound_message_review' || { echo 'review inbox item not found'; exit 1; }
INBOX_ID=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT id FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND type='inbound_message_review' AND source_id='$AMBIGUOUS_INBOUND_ID'::uuid AND status='open' ORDER BY created_at DESC LIMIT 1;\"" | tr -d '\r[:space:]')
[ -n "$INBOX_ID" ] || { echo 'could not resolve inbox id'; exit 1; }

printf '27/38 resolve inbox item... '
RESOLVE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/inbox/$INBOX_ID/resolve" -H "x-organization-id: $ORG_ID")
printf '%s' "$RESOLVE_JSON" | grep -q '"status":"resolved"' || { echo 'inbox item was not resolved'; exit 1; }
echo OK

printf '28/38 select planner event context through rule-based command... '
PLANNER_SENDER='planner-smoke'
CTX_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Selecione o evento Ana & Pedro\",\"idempotencyKey\":\"smoke-context-1\"}")
printf '%s' "$CTX_COMMAND" | grep -q '"intent":"SET_CURRENT_EVENT"' || { echo "context command failed: $CTX_COMMAND"; exit 1; }
printf '%s' "$CTX_COMMAND" | grep -q "$EVENT_ID" || { echo 'command did not resolve Ana & Pedro'; exit 1; }
echo OK

printf '29/38 create task from conversational context... '
TASK_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Crie uma tarefa para confirmar o buffet amanhã às 10h\",\"idempotencyKey\":\"smoke-command-task-1\"}")
printf '%s' "$TASK_COMMAND" | grep -q '"intent":"CREATE_TASK"' || { echo "create task command failed: $TASK_COMMAND"; exit 1; }
printf '%s' "$TASK_COMMAND" | grep -q '"status":"processed"' || { echo "task command not processed: $TASK_COMMAND"; exit 1; }
COMMAND_REQUEST_ID=$(printf '%s' "$TASK_COMMAND" | sed -n 's/.*"request":{"id":"\([^"]*\)".*/\1/p')
[ -n "$COMMAND_REQUEST_ID" ] || { echo 'could not extract command request id'; exit 1; }
echo OK

printf '30/38 verify command-created task traceability... '
COMMAND_TASK_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,title,source,source_command_request_id FROM event_tasks WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND source_command_request_id='$COMMAND_REQUEST_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$COMMAND_TASK_ROW" | grep -q "|confirmar o buffet|automation|$COMMAND_REQUEST_ID$" || { echo "unexpected command task: $COMMAND_TASK_ROW"; exit 1; }
COMMAND_TASK_ID=$(printf '%s' "$COMMAND_TASK_ROW" | cut -d'|' -f1)
echo OK

printf '31/38 query event status using saved conversation context... '
STATUS_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Como está o evento?\",\"idempotencyKey\":\"smoke-command-status-1\"}")
printf '%s' "$STATUS_COMMAND" | grep -q '"intent":"GET_EVENT_STATUS"' || { echo "status command failed: $STATUS_COMMAND"; exit 1; }
printf '%s' "$STATUS_COMMAND" | grep -q '"name":"Ana & Pedro"' || { echo 'status query lost conversation context'; exit 1; }
echo OK

printf '32/38 complete task through command engine... '
COMPLETE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Conclua a tarefa confirmar o buffet\",\"idempotencyKey\":\"smoke-command-complete-1\"}")
printf '%s' "$COMPLETE_COMMAND" | grep -q '"intent":"COMPLETE_TASK"' || { echo "complete command failed: $COMPLETE_COMMAND"; exit 1; }
TASK_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM event_tasks WHERE id='$COMMAND_TASK_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$TASK_STATUS" = 'completed' ] || { echo "expected completed task, got $TASK_STATUS"; exit 1; }
echo OK

printf '33/38 add event note through command engine... '
NOTE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Adicione uma observação dizendo que a avó da noiva precisa de acesso facilitado\",\"idempotencyKey\":\"smoke-command-note-1\"}")
printf '%s' "$NOTE_COMMAND" | grep -q '"intent":"ADD_EVENT_NOTE"' || { echo "note command failed: $NOTE_COMMAND"; exit 1; }
NOTE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_notes WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND body ILIKE '%acesso facilitado%';\"" | tr -d '\r[:space:]')
[ "$NOTE_COUNT" = '1' ] || { echo "expected one command note, got $NOTE_COUNT"; exit 1; }
echo OK

printf '34/38 verify command activity projection... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  COMMAND_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action IN ('task.created','task.completed','event.note_added');\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${COMMAND_ACTIVITY:-0}" -ge 3 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${COMMAND_ACTIVITY:-0}" -ge 3 ] || { echo "command activities not projected: ${COMMAND_ACTIVITY:-0}"; exit 1; }

printf '35/38 reject sensitive change without mutating event... '
BEFORE_START=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT start_at::text FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r')
SENSITIVE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Mude o horário do casamento da Ana para 17h\",\"idempotencyKey\":\"smoke-sensitive-1\"}")
printf '%s' "$SENSITIVE_COMMAND" | grep -q '"status":"rejected"' || { echo "sensitive command was not rejected: $SENSITIVE_COMMAND"; exit 1; }
printf '%s' "$SENSITIVE_COMMAND" | grep -q '"requiresChangeProposal":true' || { echo 'change proposal gate missing'; exit 1; }
AFTER_START=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT start_at::text FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r')
[ "$BEFORE_START" = "$AFTER_START" ] || { echo 'sensitive command mutated event'; exit 1; }
echo OK

printf '36/38 verify command idempotency... '
TASK_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Crie uma tarefa para confirmar o buffet amanhã às 10h\",\"idempotencyKey\":\"smoke-command-task-1\"}")
printf '%s' "$TASK_RETRY" | grep -q '"duplicate":true' || { echo "command retry was not idempotent: $TASK_RETRY"; exit 1; }
COMMAND_TASK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_tasks WHERE source_command_request_id='$COMMAND_REQUEST_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$COMMAND_TASK_COUNT" = '1' ] || { echo "expected one task for command request, got $COMMAND_TASK_COUNT"; exit 1; }
echo OK

printf '37/38 verify persisted conversation context... '
CONTEXT_JSON=$(curl -fsS "$BASE_URL/api/v1/command-context?sender=$PLANNER_SENDER" -H "x-organization-id: $ORG_ID")
printf '%s' "$CONTEXT_JSON" | grep -q "$EVENT_ID" || { echo "conversation context mismatch: $CONTEXT_JSON"; exit 1; }
echo OK

printf '38/38 verify all generated domain events were acknowledged... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  PENDING=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE organization_id='$ORG_ID'::uuid AND dispatched_at IS NULL;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$PENDING" = '0' ]; then echo OK; echo 'Smoke test passed.'; exit 0; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done

echo "outbox still has pending events after ${OUTBOX_WAIT_SECONDS}s"
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT id,event_type,aggregate_id,attempts,dispatched_at,last_error FROM outbox_events WHERE organization_id='$ORG_ID'::uuid ORDER BY created_at;\"" || true
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT * FROM activity_entries WHERE organization_id='$ORG_ID'::uuid ORDER BY occurred_at;\"" || true
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT * FROM inbox_items WHERE organization_id='$ORG_ID'::uuid ORDER BY created_at;\"" || true
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT * FROM outbound_messages WHERE organization_id='$ORG_ID'::uuid ORDER BY created_at;\"" || true
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -x -c \"SELECT * FROM inbound_messages WHERE organization_id='$ORG_ID'::uuid OR organization_id IS NULL ORDER BY received_at DESC LIMIT 20;\"" || true
exit 1
