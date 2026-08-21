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

printf '1/90 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/90 install and publish n8n workflow... '
if N8N_SYNC_OUTPUT=$(./scripts/n8n-sync.sh 2>&1); then
  echo OK
else
  echo FAILED
  printf '%s\n' "$N8N_SYNC_OUTPUT" >&2
  exit 1
fi

printf '3/90 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" -H 'content-type: application/json' -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo 'could not extract organization id'; exit 1; }
echo "$ORG_ID"

printf '4/90 create wedding template... '
TEMPLATE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/event-templates" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Casamento Padrão Smoke","eventType":"wedding"}')
TEMPLATE_ID=$(printf '%s' "$TEMPLATE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$TEMPLATE_ID" ] || { echo 'could not extract template id'; exit 1; }
echo "$TEMPLATE_ID"

printf '5/90 add template plan... '
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Fechar RSVP","offsetDays":-30,"dueTime":"09:00","priority":"high","type":"guest"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Confirmar fornecedores","offsetDays":-7,"dueTime":"10:00","priority":"critical","type":"confirmation"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/milestones" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Checklist final","offsetDays":-1,"dueTime":"18:00"}' >/dev/null
echo OK

printf '6/90 create event from template... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ana & Pedro\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-17T17:30:00-03:00\",\"guestCount\":132}")
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo 'could not extract event id'; exit 1; }
echo "$EVENT_ID"

printf '7/90 verify event plan regression... '
TASKS_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H "x-organization-id: $ORG_ID")
printf '%s' "$TASKS_JSON" | grep -q '2026-09-17T12:00:00.000Z' || { echo 'D-30 date mismatch'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-10-10T13:00:00.000Z' || { echo 'D-7 date mismatch'; exit 1; }
echo OK

printf '8/90 create vendor catalog entry... '
VENDOR_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Luz Foto","category":"photo","contactName":"Carla","phone":"+5521999999999","email":"foto@example.com"}')
VENDOR_ID=$(printf '%s' "$VENDOR_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$VENDOR_ID" ] || { echo 'could not extract vendor id'; exit 1; }
echo "$VENDOR_ID"

printf '9/90 attach vendor to event... '
ASSIGNMENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\",\"contractStatus\":\"signed\",\"paymentStatus\":\"partial\"}")
ASSIGNMENT_ID=$(printf '%s' "$ASSIGNMENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ASSIGNMENT_ID" ] || { echo 'could not extract event vendor id'; exit 1; }
echo "$ASSIGNMENT_ID"

printf '10/90 request vendor confirmation... '
REQUEST_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"deadlineAt":"2026-10-10T09:00:00-03:00"}')
printf '%s' "$REQUEST_JSON" | grep -q '"confirmationStatus":"requested"' || { echo 'confirmation request state mismatch'; exit 1; }
echo OK

printf '11/90 verify n8n created and sent one outbound message... '
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

printf '12/90 verify outbound idempotency... '
MESSAGE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE aggregate_id='$ASSIGNMENT_ID'::uuid AND message_type='vendor_confirmation';\"" | tr -d '\r[:space:]')
[ "$MESSAGE_COUNT" = '1' ] || { echo "expected 1 outbound message, got $MESSAGE_COUNT"; exit 1; }
echo OK

DELIVERED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
READ_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

printf '13/90 simulate delivered through generic messaging webhook... '
post_mock_provider_status "$EXTERNAL_ID" delivered "$DELIVERED_AT"
echo OK

printf '14/90 verify delivered tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'delivered' ] || { echo "expected delivered, got $STATUS"; exit 1; }
echo OK

printf '15/90 simulate read through generic messaging webhook... '
post_mock_provider_status "$EXTERNAL_ID" read "$READ_AT"
echo OK

printf '16/90 verify read tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'read' ] || { echo "expected read, got $STATUS"; exit 1; }
echo OK

printf '17/90 verify provider webhook idempotency... '
post_mock_provider_status "$EXTERNAL_ID" read "$READ_AT"
WEBHOOK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM messaging_webhook_events WHERE provider='mock' AND external_event_id='mock:$EXTERNAL_ID:read:$READ_AT';\"" | tr -d '\r[:space:]')
[ "$WEBHOOK_COUNT" = '1' ] || { echo "expected one canonical webhook receipt, got $WEBHOOK_COUNT"; exit 1; }
echo OK

printf '18/90 simulate supplier inbound confirmation... '
INBOUND_EXTERNAL_ID="mock-inbound-$ASSIGNMENT_ID"
# Keep the simulated reply strictly after the outbound send timestamp.
sleep 1
INBOUND_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
post_mock_inbound_message "$INBOUND_EXTERNAL_ID" '5521999999999' 'Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.' "$INBOUND_AT"
echo OK

printf '19/90 verify inbound message persisted and correlated... '
ATTEMPT=0
INBOUND_ROW=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  INBOUND_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,status,resolved_event_vendor_id FROM inbound_messages WHERE provider='mock' AND external_message_id='$INBOUND_EXTERNAL_ID';\"" 2>/dev/null | tr -d '\r')
  if printf '%s' "$INBOUND_ROW" | grep -q "|processed|$ASSIGNMENT_ID$"; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$INBOUND_ROW" | grep -q "|processed|$ASSIGNMENT_ID$" || { echo "inbound message was not processed: $INBOUND_ROW"; exit 1; }
INBOUND_ID=$(printf '%s' "$INBOUND_ROW" | cut -d'|' -f1)

printf '20/90 verify supplier response updated vendor assignment... '
VENDOR_STATE=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT confirmation_status,(arrival_at = '2026-10-17T17:30:00Z'::timestamptz),team_size FROM event_vendors WHERE id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$VENDOR_STATE" | grep -q '^confirmed|t|3$' || { echo "unexpected vendor state: $VENDOR_STATE"; exit 1; }
echo OK

printf '21/90 verify inbound webhook/process idempotency... '
post_mock_inbound_message "$INBOUND_EXTERNAL_ID" '5521999999999' 'Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.' "$INBOUND_AT"
INBOUND_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbound_messages WHERE provider='mock' AND external_message_id='$INBOUND_EXTERNAL_ID';\"" | tr -d '\r[:space:]')
CONFIRMED_EVENTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE organization_id='$ORG_ID'::uuid AND event_type='vendor.confirmed' AND aggregate_id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$INBOUND_COUNT" = '1' ] || { echo "expected one inbound message, got $INBOUND_COUNT"; exit 1; }
[ "$CONFIRMED_EVENTS" = '1' ] || { echo "expected one vendor.confirmed event, got $CONFIRMED_EVENTS"; exit 1; }
echo OK

printf '22/90 verify event activity timeline... '
ATTEMPT=0
ACTIVITY_JSON=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  ACTIVITY_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/activity" -H "x-organization-id: $ORG_ID")
  if printf '%s' "$ACTIVITY_JSON" | grep -q 'vendor.confirmed' && printf '%s' "$ACTIVITY_JSON" | grep -q 'message.received'; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$ACTIVITY_JSON" | grep -q 'vendor.confirmed' || { echo 'vendor.confirmed missing from activity timeline'; exit 1; }
printf '%s' "$ACTIVITY_JSON" | grep -q 'message.received' || { echo 'message.received missing from activity timeline'; exit 1; }

printf '23/90 verify activity projection idempotency... '
CONFIRMED_ACTIVITY_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action='vendor.confirmed';\"" | tr -d '\r[:space:]')
[ "$CONFIRMED_ACTIVITY_COUNT" = '1' ] || { echo "expected one vendor.confirmed activity, got $CONFIRMED_ACTIVITY_COUNT"; exit 1; }
echo OK

printf '24/90 create two pending confirmation contexts for ambiguity... '
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

printf '25/90 simulate ambiguous supplier response... '
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

printf '26/90 verify operational inbox item... '
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

printf '27/90 resolve inbox item... '
RESOLVE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/inbox/$INBOX_ID/resolve" -H "x-organization-id: $ORG_ID")
printf '%s' "$RESOLVE_JSON" | grep -q '"status":"resolved"' || { echo 'inbox item was not resolved'; exit 1; }
echo OK

printf '28/90 select planner event context through rule-based command... '
PLANNER_SENDER='planner-smoke'
CTX_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Selecione o evento Ana & Pedro\",\"idempotencyKey\":\"smoke-context-1\"}")
printf '%s' "$CTX_COMMAND" | grep -q '"intent":"SET_CURRENT_EVENT"' || { echo "context command failed: $CTX_COMMAND"; exit 1; }
printf '%s' "$CTX_COMMAND" | grep -q "$EVENT_ID" || { echo 'command did not resolve Ana & Pedro'; exit 1; }
echo OK

printf '29/90 create task from conversational context... '
TASK_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Crie uma tarefa para confirmar o buffet amanha as 10h\",\"idempotencyKey\":\"smoke-command-task-1\"}")
printf '%s' "$TASK_COMMAND" | grep -q '"intent":"CREATE_TASK"' || { echo "create task command failed: $TASK_COMMAND"; exit 1; }
printf '%s' "$TASK_COMMAND" | grep -q '"status":"processed"' || { echo "task command not processed: $TASK_COMMAND"; exit 1; }
COMMAND_REQUEST_ID=$(printf '%s' "$TASK_COMMAND" | sed -n 's/.*"request":{"id":"\([^"]*\)".*/\1/p')
[ -n "$COMMAND_REQUEST_ID" ] || { echo 'could not extract command request id'; exit 1; }
echo OK

printf '30/90 verify command-created task traceability... '
COMMAND_TASK_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,title,source,source_command_request_id FROM event_tasks WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND source_command_request_id='$COMMAND_REQUEST_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$COMMAND_TASK_ROW" | grep -q "|confirmar o buffet|automation|$COMMAND_REQUEST_ID$" || { echo "unexpected command task: $COMMAND_TASK_ROW"; exit 1; }
COMMAND_TASK_ID=$(printf '%s' "$COMMAND_TASK_ROW" | cut -d'|' -f1)
echo OK

printf '31/90 query event status using saved conversation context... '
STATUS_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Como esta o evento?\",\"idempotencyKey\":\"smoke-command-status-1\"}")
printf '%s' "$STATUS_COMMAND" | grep -q '"intent":"GET_EVENT_STATUS"' || { echo "status command failed: $STATUS_COMMAND"; exit 1; }
printf '%s' "$STATUS_COMMAND" | grep -q '"name":"Ana & Pedro"' || { echo 'status query lost conversation context'; exit 1; }
echo OK

printf '32/90 complete task through command engine... '
COMPLETE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Conclua a tarefa confirmar o buffet\",\"idempotencyKey\":\"smoke-command-complete-1\"}")
printf '%s' "$COMPLETE_COMMAND" | grep -q '"intent":"COMPLETE_TASK"' || { echo "complete command failed: $COMPLETE_COMMAND"; exit 1; }
TASK_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM event_tasks WHERE id='$COMMAND_TASK_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$TASK_STATUS" = 'completed' ] || { echo "expected completed task, got $TASK_STATUS"; exit 1; }
echo OK

printf '33/90 add event note through command engine... '
NOTE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Adicione uma observacao dizendo que a avo da noiva precisa de acesso facilitado\",\"idempotencyKey\":\"smoke-command-note-1\"}")
printf '%s' "$NOTE_COMMAND" | grep -q '"intent":"ADD_EVENT_NOTE"' || { echo "note command failed: $NOTE_COMMAND"; exit 1; }
NOTE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_notes WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND body ILIKE '%acesso facilitado%';\"" | tr -d '\r[:space:]')
[ "$NOTE_COUNT" = '1' ] || { echo "expected one command note, got $NOTE_COUNT"; exit 1; }
echo OK

printf '34/90 verify command activity projection... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  COMMAND_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action IN ('task.created','task.completed','event.note_added');\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${COMMAND_ACTIVITY:-0}" -ge 3 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${COMMAND_ACTIVITY:-0}" -ge 3 ] || { echo "command activities not projected: ${COMMAND_ACTIVITY:-0}"; exit 1; }

printf '35/90 reject sensitive change without mutating event... '
BEFORE_START=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT start_at::text FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r')
SENSITIVE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Mude o horario do casamento da Ana para 17h\",\"idempotencyKey\":\"smoke-sensitive-1\"}")
printf '%s' "$SENSITIVE_COMMAND" | grep -q '"status":"rejected"' || { echo "sensitive command was not rejected: $SENSITIVE_COMMAND"; exit 1; }
printf '%s' "$SENSITIVE_COMMAND" | grep -q '"requiresChangeProposal":true' || { echo 'change proposal gate missing'; exit 1; }
AFTER_START=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT start_at::text FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r')
[ "$BEFORE_START" = "$AFTER_START" ] || { echo 'sensitive command mutated event'; exit 1; }
echo OK

printf '36/90 verify command idempotency... '
TASK_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Crie uma tarefa para confirmar o buffet amanha as 10h\",\"idempotencyKey\":\"smoke-command-task-1\"}")
printf '%s' "$TASK_RETRY" | grep -q '"duplicate":true' || { echo "command retry was not idempotent: $TASK_RETRY"; exit 1; }
COMMAND_TASK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_tasks WHERE source_command_request_id='$COMMAND_REQUEST_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$COMMAND_TASK_COUNT" = '1' ] || { echo "expected one task for command request, got $COMMAND_TASK_COUNT"; exit 1; }
echo OK

printf '37/90 verify persisted conversation context... '
CONTEXT_JSON=$(curl -fsS "$BASE_URL/api/v1/command-context?sender=$PLANNER_SENDER" -H "x-organization-id: $ORG_ID")
printf '%s' "$CONTEXT_JSON" | grep -q "$EVENT_ID" || { echo "conversation context mismatch: $CONTEXT_JSON"; exit 1; }
echo OK

printf '38/90 operational agent workspace overview through deterministic smoke provider... '
AGENT_SENDER='planner-agent-smoke'
AGENT_OVERVIEW=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$AGENT_SENDER\",\"text\":\"Como estao meus eventos?\",\"idempotencyKey\":\"smoke-agent-overview-1\"}")
printf '%s' "$AGENT_OVERVIEW" | grep -q '"status":"completed"' || { echo "agent overview failed: $AGENT_OVERVIEW"; exit 1; }
AGENT_OVERVIEW_TURN_ID=$(printf '%s' "$AGENT_OVERVIEW" | sed -n 's/.*"turn":{"id":"\([^"]*\)".*/\1/p')
[ -n "$AGENT_OVERVIEW_TURN_ID" ] || { echo 'could not extract agent overview turn id'; exit 1; }
AGENT_OVERVIEW_TOOL=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT tool_trace->0->>'name' FROM agent_turns WHERE id='$AGENT_OVERVIEW_TURN_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$AGENT_OVERVIEW_TOOL" = 'get_workspace_overview' ] || { echo "expected workspace tool, got $AGENT_OVERVIEW_TOOL"; exit 1; }
echo OK

printf '39/90 operational agent creates task through structured CommandEngine delegation... '
AGENT_TASK=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$AGENT_SENDER\",\"eventId\":\"$EVENT_ID\",\"text\":\"Crie uma tarefa para confirmar o buffet em 2026-10-01T10:00:00-03:00\",\"idempotencyKey\":\"smoke-agent-task-1\"}")
printf '%s' "$AGENT_TASK" | grep -q '"status":"completed"' || { echo "agent task failed: $AGENT_TASK"; exit 1; }
AGENT_TASK_TURN_ID=$(printf '%s' "$AGENT_TASK" | sed -n 's/.*"turn":{"id":"\([^"]*\)".*/\1/p')
[ -n "$AGENT_TASK_TURN_ID" ] || { echo 'could not extract agent task turn id'; exit 1; }
echo OK

printf '40/90 verify agent write used CommandEngine and domain task path... '
AGENT_COMMAND_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT cr.id,cr.interpreter,cr.status,et.id,et.source,et.title FROM command_requests cr JOIN event_tasks et ON et.source_command_request_id=cr.id WHERE cr.organization_id='$ORG_ID'::uuid AND cr.idempotency_key LIKE 'agent:$AGENT_TASK_TURN_ID:%:CREATE_TASK' ORDER BY cr.created_at DESC LIMIT 1;\"" | tr -d '\r')
printf '%s' "$AGENT_COMMAND_ROW" | grep -q '|agent|processed|.*|ai|Confirmar buffet$' || { echo "agent command delegation mismatch: $AGENT_COMMAND_ROW"; exit 1; }
echo OK

printf '41/90 verify operational agent turn idempotency... '
AGENT_TASK_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$AGENT_SENDER\",\"eventId\":\"$EVENT_ID\",\"text\":\"Crie uma tarefa para confirmar o buffet em 2026-10-01T10:00:00-03:00\",\"idempotencyKey\":\"smoke-agent-task-1\"}")
printf '%s' "$AGENT_TASK_RETRY" | grep -q '"duplicate":true' || { echo "agent retry was not idempotent: $AGENT_TASK_RETRY"; exit 1; }
AGENT_TASK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_tasks et JOIN command_requests cr ON cr.id=et.source_command_request_id WHERE cr.organization_id='$ORG_ID'::uuid AND cr.idempotency_key LIKE 'agent:$AGENT_TASK_TURN_ID:%:CREATE_TASK';\"" | tr -d '\r[:space:]')
[ "$AGENT_TASK_COUNT" = '1' ] || { echo "expected one agent-created task, got $AGENT_TASK_COUNT"; exit 1; }
echo OK

printf '42/90 verify operational agent conversation history... '
AGENT_HISTORY=$(curl -fsS "$BASE_URL/api/v1/agent/history?sender=$AGENT_SENDER&limit=10" -H "x-organization-id: $ORG_ID")
printf '%s' "$AGENT_HISTORY" | grep -q "$AGENT_OVERVIEW_TURN_ID" || { echo 'overview turn missing from agent history'; exit 1; }
printf '%s' "$AGENT_HISTORY" | grep -q "$AGENT_TASK_TURN_ID" || { echo 'task turn missing from agent history'; exit 1; }
echo OK

printf '43/90 operational agent creates sensitive time change proposal... '
CHANGE_SENDER='planner-change-smoke'
BEFORE_CHANGE_TIME=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT to_char(start_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
AGENT_CHANGE=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"eventId\":\"$EVENT_ID\",\"text\":\"Mude o horario do casamento para 17h\",\"idempotencyKey\":\"smoke-agent-change-proposal-1\"}")
printf '%s' "$AGENT_CHANGE" | grep -q 'Proposta criada' || { echo "agent did not create change proposal: $AGENT_CHANGE"; exit 1; }
CHANGE_PROPOSAL_ID=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT id FROM change_proposals WHERE organization_id='$ORG_ID'::uuid AND requested_by_sender='$CHANGE_SENDER' AND type='event_time' ORDER BY created_at DESC LIMIT 1;\"" | tr -d '\r[:space:]')
[ -n "$CHANGE_PROPOSAL_ID" ] || { echo 'change proposal was not persisted'; exit 1; }
CHANGE_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM change_proposals WHERE id='$CHANGE_PROPOSAL_ID'::uuid;\"" | tr -d '\r[:space:]')
AFTER_PROPOSAL_TIME=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT to_char(start_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$CHANGE_STATUS" = 'proposed' ] && [ "$BEFORE_CHANGE_TIME" = "$AFTER_PROPOSAL_TIME" ] || { echo "proposal mutated event or wrong status: status=$CHANGE_STATUS before=$BEFORE_CHANGE_TIME after=$AFTER_PROPOSAL_TIME"; exit 1; }
echo OK

printf '44/90 verify proposal impacts and approval inbox projection... '
IMPACT_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM change_proposal_impacts WHERE proposal_id='$CHANGE_PROPOSAL_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "${IMPACT_COUNT:-0}" -ge 1 ] || { echo "proposal impacts missing: $IMPACT_COUNT"; exit 1; }
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  CHANGE_INBOX=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='change_proposal' AND source_id='$CHANGE_PROPOSAL_ID'::uuid AND status='open';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$CHANGE_INBOX" = '1' ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${CHANGE_INBOX:-0}" = '1' ] || { echo 'change proposal inbox item not projected'; exit 1; }

printf '45/90 approve pending proposal through conversational follow-up... '
AGENT_APPROVE=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"text\":\"sim\",\"idempotencyKey\":\"smoke-agent-change-approve-1\"}")
printf '%s' "$AGENT_APPROVE" | grep -q 'aprovada e aplicada' || { echo "agent approval failed: $AGENT_APPROVE"; exit 1; }
APPLIED_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM change_proposals WHERE id='$CHANGE_PROPOSAL_ID'::uuid;\"" | tr -d '\r[:space:]')
APPLIED_TIME=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT to_char(start_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$APPLIED_STATUS" = 'applied' ] && [ "$APPLIED_TIME" = '17:00' ] || { echo "proposal was not applied correctly: status=$APPLIED_STATUS time=$APPLIED_TIME"; exit 1; }
echo OK

printf '46/90 verify approval idempotency... '
AGENT_APPROVE_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"text\":\"sim\",\"idempotencyKey\":\"smoke-agent-change-approve-1\"}")
printf '%s' "$AGENT_APPROVE_RETRY" | grep -q '"duplicate":true' || { echo "agent approval retry was not idempotent: $AGENT_APPROVE_RETRY"; exit 1; }
CHANGE_APPLIED_EVENTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE aggregate_id='$CHANGE_PROPOSAL_ID'::uuid AND event_type='change.applied';\"" | tr -d '\r[:space:]')
[ "$CHANGE_APPLIED_EVENTS" = '1' ] || { echo "expected one change.applied event, got $CHANGE_APPLIED_EVENTS"; exit 1; }
echo OK

printf '47/90 verify change activity and inbox resolution... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  CHANGE_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND entity_type='change_proposal' AND entity_id='$CHANGE_PROPOSAL_ID'::uuid AND action IN ('change.proposed','change.applied');\"" 2>/dev/null | tr -d '\r[:space:]')
  CHANGE_INBOX_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='change_proposal' AND source_id='$CHANGE_PROPOSAL_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${CHANGE_ACTIVITY:-0}" -ge 2 ] && [ "$CHANGE_INBOX_STATUS" = 'resolved' ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${CHANGE_ACTIVITY:-0}" -ge 2 ] && [ "$CHANGE_INBOX_STATUS" = 'resolved' ] || { echo "change projection mismatch activity=${CHANGE_ACTIVITY:-0} inbox=$CHANGE_INBOX_STATUS"; exit 1; }

printf '48/90 wait for dependency evaluation after applied time change... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DEP_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM dependency_impacts WHERE organization_id='$ORG_ID'::uuid AND proposal_id='$CHANGE_PROPOSAL_ID'::uuid;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${DEP_COUNT:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${DEP_COUNT:-0}" -ge 1 ] || { echo 'dependency impacts were not generated from change.applied'; exit 1; }

printf '49/90 verify dependency API and inbox projection... '
DEPENDENCIES_JSON=$(curl -fsS "$BASE_URL/api/v1/dependencies?proposalId=$CHANGE_PROPOSAL_ID&status=open" -H "x-organization-id: $ORG_ID")
printf '%s' "$DEPENDENCIES_JSON" | grep -q 'vendor_schedule' || { echo "vendor schedule dependency missing: $DEPENDENCIES_JSON"; exit 1; }
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DEP_INBOX=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='dependency_impact' AND status='open';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${DEP_INBOX:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${DEP_INBOX:-0}" -ge 1 ] || { echo 'dependency inbox item was not projected'; exit 1; }

printf '50/90 apply safe dependency suggestions through conversational agent... '
DEP_APPLY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"text\":\"Recalcule todos os ajustes\",\"idempotencyKey\":\"smoke-agent-dependency-apply-1\"}")
printf '%s' "$DEP_APPLY" | grep -q 'ajuste(s) de dependência aplicado(s)' || { echo "agent dependency apply failed: $DEP_APPLY"; exit 1; }
echo OK

printf '51/90 verify dependency suggestion updated vendor schedule... '
DEP_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM dependency_impacts WHERE organization_id='$ORG_ID'::uuid AND proposal_id='$CHANGE_PROPOSAL_ID'::uuid AND dependency_type='vendor_schedule' ORDER BY created_at DESC LIMIT 1;\"" | tr -d '\r[:space:]')
VENDOR_ARRIVAL=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT to_char(arrival_at AT TIME ZONE 'UTC','YYYY-MM-DD\\\"T\\\"HH24:MI:SS\\\"Z\\\"') FROM event_vendors WHERE id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$DEP_STATUS" = 'applied' ] && [ "$VENDOR_ARRIVAL" = '2026-10-17T17:00:00Z' ] || { echo "dependency application mismatch status=$DEP_STATUS arrival=$VENDOR_ARRIVAL"; exit 1; }
echo OK

printf '52/90 verify dependency activity and inbox resolution... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DEP_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND action IN ('dependency.evaluation_completed','dependency.applied');\"" 2>/dev/null | tr -d '\r[:space:]')
  DEP_RESOLVED=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='dependency_impact' AND status='resolved';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${DEP_ACTIVITY:-0}" -ge 2 ] && [ "${DEP_RESOLVED:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${DEP_ACTIVITY:-0}" -ge 2 ] && [ "${DEP_RESOLVED:-0}" -ge 1 ] || { echo "dependency projection mismatch activity=${DEP_ACTIVITY:-0} resolved=${DEP_RESOLVED:-0}"; exit 1; }

printf '53/90 create overdue critical task for risk evaluation... '
RISK_TASK_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Resolver pendência crítica","type":"general","priority":"critical","dueAt":"2026-08-18T09:00:00-03:00"}')
RISK_TASK_ID=$(printf '%s' "$RISK_TASK_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$RISK_TASK_ID" ] || { echo 'could not extract risk task id'; exit 1; }
echo OK

printf '54/90 wait for Risk Engine to detect overdue task... '
ATTEMPT=0
RISK_ID=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  RISK_ID=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT id FROM event_risks WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND source_type='task' AND source_id='$RISK_TASK_ID'::uuid AND type='task_overdue' AND status='open' ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ -n "$RISK_ID" ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ -n "$RISK_ID" ] || { echo 'Risk Engine did not persist task_overdue'; exit 1; }

printf '55/90 verify risk API and high-risk inbox projection... '
RISKS_JSON=$(curl -fsS "$BASE_URL/api/v1/risks?eventId=$EVENT_ID&status=open&minScore=50" -H "x-organization-id: $ORG_ID")
printf '%s' "$RISKS_JSON" | grep -q 'task_overdue' || { echo "task_overdue missing from risk API: $RISKS_JSON"; exit 1; }
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  RISK_INBOX_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='event_risk' AND source_id='$RISK_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$RISK_INBOX_STATUS" = 'open' ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "$RISK_INBOX_STATUS" = 'open' ] || { echo "expected open risk inbox, got $RISK_INBOX_STATUS"; exit 1; }

printf '56/90 query event risks through Operational Agent... '
AGENT_RISKS=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"risk-smoke\",\"explicitEventId\":\"$EVENT_ID\",\"text\":\"Quais riscos preocupam neste evento?\",\"idempotencyKey\":\"smoke-agent-risks-1\"}")
printf '%s' "$AGENT_RISKS" | grep -q 'get_event_risks' || { echo "agent did not use get_event_risks: $AGENT_RISKS"; exit 1; }
echo OK

printf '57/90 wait for Health Score degradation and query API... '
ATTEMPT=0
HEALTH_SCORE_WITH_RISK=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  HEALTH_SCORE_WITH_RISK=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT health_score FROM events WHERE id='$EVENT_ID'::uuid;\"" 2>/dev/null | tr -d '\r[:space:]')
  HEALTH_EVAL_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_health_evaluations WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ -n "$HEALTH_SCORE_WITH_RISK" ] && [ "$HEALTH_SCORE_WITH_RISK" -lt 100 ] && [ "${HEALTH_EVAL_COUNT:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ -n "$HEALTH_SCORE_WITH_RISK" ] && [ "$HEALTH_SCORE_WITH_RISK" -lt 100 ] || { echo "Health Score did not degrade after active risk: score=${HEALTH_SCORE_WITH_RISK:-missing}"; exit 1; }
HEALTH_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/health-score" -H "x-organization-id: $ORG_ID")
printf '%s' "$HEALTH_JSON" | grep -q '"breakdown"' || { echo "health API missing breakdown: $HEALTH_JSON"; exit 1; }

printf '58/90 query Health Score through Operational Agent... '
AGENT_HEALTH=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"health-smoke\",\"explicitEventId\":\"$EVENT_ID\",\"text\":\"Qual a saude deste evento?\",\"idempotencyKey\":\"smoke-agent-health-1\"}")
printf '%s' "$AGENT_HEALTH" | grep -q 'get_event_health' || { echo "agent did not use get_event_health: $AGENT_HEALTH"; exit 1; }
echo OK

printf '59/90 verify manual Health Score evaluation idempotency... '
HEALTH_MANUAL_1=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/health-score/evaluate" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"idempotencyKey":"smoke-health-manual-1"}')
HEALTH_MANUAL_2=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/health-score/evaluate" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"idempotencyKey":"smoke-health-manual-1"}')
printf '%s' "$HEALTH_MANUAL_1" | grep -q '"duplicate":false' || { echo "first health evaluation should not be duplicate: $HEALTH_MANUAL_1"; exit 1; }
printf '%s' "$HEALTH_MANUAL_2" | grep -q '"duplicate":true' || { echo "second health evaluation should be duplicate: $HEALTH_MANUAL_2"; exit 1; }
echo OK

printf '60/90 acknowledge risk without resolving its cause... '
ACK_RISK=$(curl -fsS -X POST "$BASE_URL/api/v1/risks/$RISK_ID/acknowledge" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"risk-smoke"}')
printf '%s' "$ACK_RISK" | grep -q '"status":"acknowledged"' || { echo "risk acknowledgement failed: $ACK_RISK"; exit 1; }
RISK_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM event_risks WHERE id='$RISK_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$RISK_STATUS" = 'acknowledged' ] || { echo "expected acknowledged risk, got $RISK_STATUS"; exit 1; }
echo OK

printf '61/90 complete underlying task and trigger automatic risk resolution... '
curl -fsS -X PATCH "$BASE_URL/api/v1/events/$EVENT_ID/tasks/$RISK_TASK_ID" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"status":"completed"}' >/dev/null
echo OK

printf '62/90 verify risk, inbox and Health Score auto-reconciled... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  RISK_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM event_risks WHERE id='$RISK_ID'::uuid;\"" 2>/dev/null | tr -d '\r[:space:]')
  RISK_INBOX_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='event_risk' AND source_id='$RISK_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r[:space:]')
  RISK_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND entity_type='event_risk' AND entity_id='$RISK_ID'::uuid AND action='risk.resolved';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$RISK_STATUS" = 'resolved' ] && [ "$RISK_INBOX_STATUS" = 'resolved' ] && [ "${RISK_ACTIVITY:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "$RISK_STATUS" = 'resolved' ] && [ "$RISK_INBOX_STATUS" = 'resolved' ] || { echo "risk auto-resolution mismatch risk=$RISK_STATUS inbox=$RISK_INBOX_STATUS activity=${RISK_ACTIVITY:-0}"; exit 1; }

ATTEMPT=0
HEALTH_SCORE_AFTER_RESOLUTION=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  HEALTH_SCORE_AFTER_RESOLUTION=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT health_score FROM events WHERE id='$EVENT_ID'::uuid;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ -n "$HEALTH_SCORE_AFTER_RESOLUTION" ] && [ "$HEALTH_SCORE_AFTER_RESOLUTION" -gt "$HEALTH_SCORE_WITH_RISK" ]; then break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ -n "$HEALTH_SCORE_AFTER_RESOLUTION" ] && [ "$HEALTH_SCORE_AFTER_RESOLUTION" -gt "$HEALTH_SCORE_WITH_RISK" ] || { echo "Health Score did not improve after risk resolution: before=$HEALTH_SCORE_WITH_RISK after=${HEALTH_SCORE_AFTER_RESOLUTION:-missing}"; exit 1; }

printf '63/90 verify Health Score history and activity... '
HEALTH_HISTORY=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/health-score/history?limit=10" -H "x-organization-id: $ORG_ID")
printf '%s' "$HEALTH_HISTORY" | grep -q '"previousScore"' || { echo "health history missing evaluations: $HEALTH_HISTORY"; exit 1; }
HEALTH_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action='health.updated';\"" | tr -d '\r[:space:]')
[ "${HEALTH_ACTIVITY:-0}" -ge 1 ] || { echo "expected health.updated activity, got ${HEALTH_ACTIVITY:-0}"; exit 1; }
echo OK

printf '64/90 configure scheduled Daily Brief through Operational Agent... '
AGENT_BRIEF_CONFIG=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"5521988887777","text":"Configure o brief para todo dia as 00:00 no +5521988887777","idempotencyKey":"smoke-agent-brief-config-1"}')
printf '%s' "$AGENT_BRIEF_CONFIG" | grep -q 'configure_daily_brief' || { echo "agent did not configure daily brief: $AGENT_BRIEF_CONFIG"; exit 1; }
printf '%s' "$AGENT_BRIEF_CONFIG" | grep -q '"enabled":true' || { echo "daily brief was not enabled: $AGENT_BRIEF_CONFIG"; exit 1; }
echo OK

printf '65/90 wait for scheduled Daily Brief and WhatsApp delivery... '
ATTEMPT=0
BRIEF_ROW=''
BRIEF_MESSAGE_ROW=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  BRIEF_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,reference_date,revision,trigger_type FROM daily_briefs WHERE organization_id='$ORG_ID'::uuid AND trigger_type='scheduled' ORDER BY generated_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r')
  BRIEF_ID=$(printf '%s' "$BRIEF_ROW" | cut -d'|' -f1)
  if [ -n "$BRIEF_ID" ]; then
    BRIEF_MESSAGE_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT message_type,status,recipient FROM outbound_messages WHERE organization_id='$ORG_ID'::uuid AND aggregate_id='$BRIEF_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r')
    if printf '%s' "$BRIEF_MESSAGE_ROW" | grep -q '^daily_brief|sent|5521988887777$'; then echo OK; break; fi
  fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$BRIEF_MESSAGE_ROW" | grep -q '^daily_brief|sent|5521988887777$' || { echo "scheduled brief message was not sent: brief=$BRIEF_ROW message=$BRIEF_MESSAGE_ROW"; exit 1; }

printf '66/90 verify scheduled Daily Brief idempotency... '
sleep 2
SCHEDULED_BRIEF_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM daily_briefs WHERE organization_id='$ORG_ID'::uuid AND trigger_type='scheduled';\"" | tr -d '\r[:space:]')
BRIEF_MESSAGE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE organization_id='$ORG_ID'::uuid AND message_type='daily_brief';\"" | tr -d '\r[:space:]')
[ "$SCHEDULED_BRIEF_COUNT" = '1' ] && [ "$BRIEF_MESSAGE_COUNT" = '1' ] || { echo "expected one scheduled brief/message, got briefs=$SCHEDULED_BRIEF_COUNT messages=$BRIEF_MESSAGE_COUNT"; exit 1; }
echo OK

printf '67/90 verify Daily Brief settings and today API... '
BRIEF_SETTINGS=$(curl -fsS "$BASE_URL/api/v1/briefs/settings" -H "x-organization-id: $ORG_ID")
printf '%s' "$BRIEF_SETTINGS" | grep -q '"localTime":"00:00"' || { echo "brief settings mismatch: $BRIEF_SETTINGS"; exit 1; }
TODAY_BRIEF=$(curl -fsS "$BASE_URL/api/v1/briefs/today" -H "x-organization-id: $ORG_ID")
printf '%s' "$TODAY_BRIEF" | grep -q '"priorities"' || { echo "today brief missing priorities: $TODAY_BRIEF"; exit 1; }
printf '%s' "$TODAY_BRIEF" | grep -q '"renderedText"' || { echo "today brief missing rendered text: $TODAY_BRIEF"; exit 1; }
echo OK

printf '68/90 query Daily Brief through Operational Agent... '
AGENT_BRIEF=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"brief-smoke","text":"Qual o brief de hoje?","idempotencyKey":"smoke-agent-brief-read-1"}')
printf '%s' "$AGENT_BRIEF" | grep -q 'get_daily_brief' || { echo "agent did not use get_daily_brief: $AGENT_BRIEF"; exit 1; }
echo OK

printf '69/90 verify manual Daily Brief revision and idempotency... '
BRIEF_MANUAL_1=$(curl -fsS -X POST "$BASE_URL/api/v1/briefs/generate" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"idempotencyKey":"smoke-brief-manual-1"}')
BRIEF_MANUAL_2=$(curl -fsS -X POST "$BASE_URL/api/v1/briefs/generate" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"idempotencyKey":"smoke-brief-manual-1"}')
printf '%s' "$BRIEF_MANUAL_1" | grep -q '"duplicate":false' || { echo "first manual brief should not be duplicate: $BRIEF_MANUAL_1"; exit 1; }
printf '%s' "$BRIEF_MANUAL_2" | grep -q '"duplicate":true' || { echo "second manual brief should be duplicate: $BRIEF_MANUAL_2"; exit 1; }
BRIEF_HISTORY=$(curl -fsS "$BASE_URL/api/v1/briefs?limit=10" -H "x-organization-id: $ORG_ID")
printf '%s' "$BRIEF_HISTORY" | grep -q '"revision":2' || { echo "brief revision history missing revision 2: $BRIEF_HISTORY"; exit 1; }
echo OK

printf '70/90 create D-1 smoke event for tomorrow... '
D1_START_AT=$(docker compose exec -T api bun -e 'console.log(new Date(Date.now()+86400000).toISOString())' | tr -d '\r[:space:]')
[ -n "$D1_START_AT" ] || { echo 'could not calculate tomorrow timestamp'; exit 1; }
D1_EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"D-1 Smoke Wedding\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"$D1_START_AT\",\"guestCount\":96}")
D1_EVENT_ID=$(printf '%s' "$D1_EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$D1_EVENT_ID" ] || { echo "could not create D-1 event: $D1_EVENT_JSON"; exit 1; }
echo "$D1_EVENT_ID"

printf '71/90 configure D-1 schedule independently through Operational Agent... '
AGENT_D1_CONFIG=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"5521977776666","text":"Configure o briefing D-1 para 00:00 no +5521977776666","idempotencyKey":"smoke-agent-d1-config-1"}')
printf '%s' "$AGENT_D1_CONFIG" | grep -q 'configure_d_minus_1_brief' || { echo "agent did not configure D-1: $AGENT_D1_CONFIG"; exit 1; }
printf '%s' "$AGENT_D1_CONFIG" | grep -q '"enabled":true' || { echo "D-1 schedule was not enabled: $AGENT_D1_CONFIG"; exit 1; }
echo OK

printf '72/90 wait for scheduled D-1 briefing and WhatsApp delivery... '
ATTEMPT=0
D1_BRIEF_ROW=''
D1_MESSAGE_ROW=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  D1_BRIEF_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,reference_date,revision,trigger_type FROM daily_briefs WHERE organization_id='$ORG_ID'::uuid AND brief_type='d_minus_1' AND event_id='$D1_EVENT_ID'::uuid AND trigger_type='scheduled' ORDER BY generated_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r')
  D1_BRIEF_ID=$(printf '%s' "$D1_BRIEF_ROW" | cut -d'|' -f1)
  if [ -n "$D1_BRIEF_ID" ]; then
    D1_MESSAGE_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT message_type,status,recipient FROM outbound_messages WHERE organization_id='$ORG_ID'::uuid AND aggregate_id='$D1_BRIEF_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r')
    if printf '%s' "$D1_MESSAGE_ROW" | grep -q '^d_minus_1_brief|sent|5521977776666$'; then echo OK; break; fi
  fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$D1_MESSAGE_ROW" | grep -q '^d_minus_1_brief|sent|5521977776666$' || { echo "scheduled D-1 was not sent: brief=$D1_BRIEF_ROW message=$D1_MESSAGE_ROW"; exit 1; }

printf '73/90 verify scheduled D-1 idempotency... '
sleep 2
D1_SCHEDULED_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM daily_briefs WHERE organization_id='$ORG_ID'::uuid AND brief_type='d_minus_1' AND event_id='$D1_EVENT_ID'::uuid AND trigger_type='scheduled';\"" | tr -d '\r[:space:]')
D1_MESSAGE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE organization_id='$ORG_ID'::uuid AND aggregate_id='$D1_BRIEF_ID'::uuid AND message_type='d_minus_1_brief';\"" | tr -d '\r[:space:]')
[ "$D1_SCHEDULED_COUNT" = '1' ] && [ "$D1_MESSAGE_COUNT" = '1' ] || { echo "expected one scheduled D-1/message, got briefs=$D1_SCHEDULED_COUNT messages=$D1_MESSAGE_COUNT"; exit 1; }
echo OK

printf '74/90 verify independent D-1 schedule settings API... '
D1_SETTINGS=$(curl -fsS "$BASE_URL/api/v1/briefs/schedules/d_minus_1" -H "x-organization-id: $ORG_ID")
printf '%s' "$D1_SETTINGS" | grep -q '"localTime":"00:00"' || { echo "D-1 schedule time mismatch: $D1_SETTINGS"; exit 1; }
printf '%s' "$D1_SETTINGS" | grep -q '"recipient":"5521977776666"' || { echo "D-1 recipient mismatch: $D1_SETTINGS"; exit 1; }
DAILY_SETTINGS_AFTER_D1=$(curl -fsS "$BASE_URL/api/v1/briefs/schedules/daily" -H "x-organization-id: $ORG_ID")
printf '%s' "$DAILY_SETTINGS_AFTER_D1" | grep -q '"recipient":"5521988887777"' || { echo "D-1 mutated Daily Brief recipient: $DAILY_SETTINGS_AFTER_D1"; exit 1; }
echo OK

printf '75/90 query D-1 readiness through Operational Agent... '
AGENT_D1=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"d1-smoke\",\"eventId\":\"$D1_EVENT_ID\",\"text\":\"Estamos prontos para amanha? Mostre o briefing D-1\",\"idempotencyKey\":\"smoke-agent-d1-read-1\"}")
printf '%s' "$AGENT_D1" | grep -q 'get_d_minus_1_brief' || { echo "agent did not use get_d_minus_1_brief: $AGENT_D1"; exit 1; }
echo OK

printf '76/90 verify D-1 deterministic readiness and timeline API... '
D1_CURRENT=$(curl -fsS "$BASE_URL/api/v1/events/$D1_EVENT_ID/briefs/d-minus-1" -H "x-organization-id: $ORG_ID")
printf '%s' "$D1_CURRENT" | grep -Eq '"readiness":"(READY|READY_WITH_WARNINGS|NOT_READY)"' || { echo "D-1 readiness missing: $D1_CURRENT"; exit 1; }
printf '%s' "$D1_CURRENT" | grep -q '"timeline"' || { echo "D-1 timeline missing: $D1_CURRENT"; exit 1; }
printf '%s' "$D1_CURRENT" | grep -q '"eventName":"D-1 Smoke Wedding"' || { echo "D-1 event identity mismatch: $D1_CURRENT"; exit 1; }
echo OK

printf '77/90 verify manual D-1 revision, idempotency and history... '
D1_MANUAL_1=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$D1_EVENT_ID/briefs/d-minus-1/generate" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"idempotencyKey":"smoke-d1-manual-1"}')
D1_MANUAL_2=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$D1_EVENT_ID/briefs/d-minus-1/generate" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"idempotencyKey":"smoke-d1-manual-1"}')
printf '%s' "$D1_MANUAL_1" | grep -q '"duplicate":false' || { echo "first manual D-1 should not be duplicate: $D1_MANUAL_1"; exit 1; }
printf '%s' "$D1_MANUAL_2" | grep -q '"duplicate":true' || { echo "second manual D-1 should be duplicate: $D1_MANUAL_2"; exit 1; }
D1_HISTORY=$(curl -fsS "$BASE_URL/api/v1/events/$D1_EVENT_ID/briefs/d-minus-1/history?limit=10" -H "x-organization-id: $ORG_ID")
printf '%s' "$D1_HISTORY" | grep -q '"revision":2' || { echo "D-1 history missing revision 2: $D1_HISTORY"; exit 1; }
echo OK

printf '78/90 create guest-count proposal through REST API... '
CURRENT_GUESTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT guest_count FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
TARGET_GUESTS=$((CURRENT_GUESTS + 25))
REST_CHANGE=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/change-proposals" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"planner-rest-smoke\",\"idempotencyKey\":\"smoke-rest-change-1\",\"type\":\"guest_count\",\"proposedValue\":{\"guestCount\":$TARGET_GUESTS}}")
printf '%s' "$REST_CHANGE" | grep -q '"status":"proposed"' || { echo "REST proposal failed: $REST_CHANGE"; exit 1; }
REST_CHANGE_ID=$(printf '%s' "$REST_CHANGE" | sed -n 's/.*"proposal":{"id":"\([^"]*\)".*/\1/p')
[ -n "$REST_CHANGE_ID" ] || { echo 'could not extract REST proposal id'; exit 1; }
echo OK

printf '79/90 reject REST proposal without mutating guest count... '
REST_REJECT=$(curl -fsS -X POST "$BASE_URL/api/v1/change-proposals/$REST_CHANGE_ID/reject" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"planner-rest-smoke","reason":"smoke rejection"}')
printf '%s' "$REST_REJECT" | grep -q '"status":"rejected"' || { echo "REST reject failed: $REST_REJECT"; exit 1; }
AFTER_REJECT_GUESTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT guest_count FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$AFTER_REJECT_GUESTS" = "$CURRENT_GUESTS" ] || { echo "rejected proposal mutated guest count: before=$CURRENT_GUESTS after=$AFTER_REJECT_GUESTS"; exit 1; }
echo OK

printf '80/90 verify workspace Health Score ranking... '
WORKSPACE_HEALTH=$(curl -fsS "$BASE_URL/api/v1/health-scores/workspace?limit=10" -H "x-organization-id: $ORG_ID")
printf '%s' "$WORKSPACE_HEALTH" | grep -q '"score"' || { echo "workspace health response missing score: $WORKSPACE_HEALTH"; exit 1; }
echo OK

printf '81/90 verify event resource exposes persisted Health Score... '
EVENT_AFTER_HEALTH=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID" -H "x-organization-id: $ORG_ID")
printf '%s' "$EVENT_AFTER_HEALTH" | grep -q "\"healthScore\":$HEALTH_SCORE_AFTER_RESOLUTION" || { echo "event healthScore mismatch: $EVENT_AFTER_HEALTH"; exit 1; }
echo OK

printf '82/90 create Event Day smoke event for today with a late supplier... '
EVENT_DAY_START_AT=$(docker compose exec -T api bun -e 'console.log(new Date().toISOString())' | tr -d '\r[:space:]')
EVENT_DAY_VENDOR_ARRIVAL=$(docker compose exec -T api bun -e 'console.log(new Date(Date.now()-45*60000).toISOString())' | tr -d '\r[:space:]')
EVENT_DAY_VENDOR_DEPARTURE=$(docker compose exec -T api bun -e 'console.log(new Date(Date.now()+3*3600000).toISOString())' | tr -d '\r[:space:]')
EVENT_DAY_EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Event Day Smoke\",\"type\":\"wedding\",\"startAt\":\"$EVENT_DAY_START_AT\",\"guestCount\":80}")
EVENT_DAY_EVENT_ID=$(printf '%s' "$EVENT_DAY_EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_DAY_EVENT_ID" ] || { echo "could not create Event Day event: $EVENT_DAY_EVENT_JSON"; exit 1; }
EVENT_DAY_ASSIGN_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\",\"arrivalAt\":\"$EVENT_DAY_VENDOR_ARRIVAL\",\"departureAt\":\"$EVENT_DAY_VENDOR_DEPARTURE\"}")
EVENT_DAY_VENDOR_ID=$(printf '%s' "$EVENT_DAY_ASSIGN_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_DAY_VENDOR_ID" ] || { echo "could not attach Event Day vendor: $EVENT_DAY_ASSIGN_JSON"; exit 1; }
curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/vendors/$EVENT_DAY_VENDOR_ID/confirm" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{}' >/dev/null
echo OK

printf '83/90 verify pre-start live snapshot and planned lateness... '
EVENT_DAY_BEFORE=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/event-day" -H "x-organization-id: $ORG_ID")
printf '%s' "$EVENT_DAY_BEFORE" | grep -q '"operationalStatus":"not_started"' || { echo "Event Day should be not_started: $EVENT_DAY_BEFORE"; exit 1; }
printf '%s' "$EVENT_DAY_BEFORE" | grep -q '"liveStatus":"late"' || { echo "late supplier was not detected before start: $EVENT_DAY_BEFORE"; exit 1; }
echo OK

printf '84/90 start Event Day and verify critical live status... '
EVENT_DAY_STARTED=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/event-day/start" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"event-day-smoke"}')
printf '%s' "$EVENT_DAY_STARTED" | grep -q '"operationalStatus":"critical"' || { echo "late supplier should make Event Day critical: $EVENT_DAY_STARTED"; exit 1; }
EVENT_DAY_DB_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM events WHERE id='$EVENT_DAY_EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$EVENT_DAY_DB_STATUS" = 'event_day' ] || { echo "event lifecycle did not enter event_day: $EVENT_DAY_DB_STATUS"; exit 1; }
echo OK

printf '85/90 query live Event Day through Operational Agent... '
AGENT_EVENT_DAY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"event-day-agent\",\"eventId\":\"$EVENT_DAY_EVENT_ID\",\"text\":\"Como está o evento agora?\",\"idempotencyKey\":\"smoke-event-day-read-1\"}")
printf '%s' "$AGENT_EVENT_DAY" | grep -q 'get_event_day_status' || { echo "agent did not use get_event_day_status: $AGENT_EVENT_DAY"; exit 1; }
echo OK

printf '86/90 record supplier arrival through Operational Agent... '
AGENT_EVENT_DAY_ARRIVAL=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"event-day-agent\",\"eventId\":\"$EVENT_DAY_EVENT_ID\",\"text\":\"O fotógrafo chegou agora\",\"idempotencyKey\":\"smoke-event-day-arrival-1\"}")
printf '%s' "$AGENT_EVENT_DAY_ARRIVAL" | grep -q 'mark_event_day_vendor_arrived' || { echo "agent did not register supplier arrival: $AGENT_EVENT_DAY_ARRIVAL"; exit 1; }
echo OK

printf '87/90 verify actual arrival is separate from planned arrival and clears lateness... '
EVENT_DAY_AFTER_ARRIVAL=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/event-day" -H "x-organization-id: $ORG_ID")
printf '%s' "$EVENT_DAY_AFTER_ARRIVAL" | grep -q '"liveStatus":"arrived"' || { echo "supplier is not arrived in live snapshot: $EVENT_DAY_AFTER_ARRIVAL"; exit 1; }
printf '%s' "$EVENT_DAY_AFTER_ARRIVAL" | grep -q '"lateVendors":0' || { echo "supplier lateness was not cleared: $EVENT_DAY_AFTER_ARRIVAL"; exit 1; }
PLANNED_ACTUAL=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT arrival_at,actual_arrival_at FROM event_vendors WHERE id='$EVENT_DAY_VENDOR_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$PLANNED_ACTUAL" | grep -q '|' || { echo "planned/actual arrival row missing: $PLANNED_ACTUAL"; exit 1; }
[ "$(printf '%s' "$PLANNED_ACTUAL" | cut -d'|' -f1)" != "$(printf '%s' "$PLANNED_ACTUAL" | cut -d'|' -f2)" ] || { echo "actual arrival overwrote planned arrival: $PLANNED_ACTUAL"; exit 1; }
echo OK

printf '88/90 record supplier departure and verify live timeline... '
EVENT_DAY_DEPART=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/event-day/vendors/$EVENT_DAY_VENDOR_ID/depart" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"event-day-smoke"}')
printf '%s' "$EVENT_DAY_DEPART" | grep -q '"liveStatus":"departed"' || { echo "supplier departure was not registered: $EVENT_DAY_DEPART"; exit 1; }
printf '%s' "$EVENT_DAY_DEPART" | grep -q '"type":"vendor_departed"' || { echo "actual departure missing from Event Day timeline: $EVENT_DAY_DEPART"; exit 1; }
echo OK

printf '89/90 complete Event Day through Operational Agent... '
AGENT_EVENT_DAY_COMPLETE=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"event-day-agent\",\"eventId\":\"$EVENT_DAY_EVENT_ID\",\"text\":\"Finalize o Event Day deste evento\",\"idempotencyKey\":\"smoke-event-day-complete-1\"}")
printf '%s' "$AGENT_EVENT_DAY_COMPLETE" | grep -q 'complete_event_day' || { echo "agent did not complete Event Day: $AGENT_EVENT_DAY_COMPLETE"; exit 1; }
EVENT_DAY_FINAL=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_DAY_EVENT_ID/event-day" -H "x-organization-id: $ORG_ID")
printf '%s' "$EVENT_DAY_FINAL" | grep -q '"operationalStatus":"completed"' || { echo "Event Day snapshot did not complete: $EVENT_DAY_FINAL"; exit 1; }
EVENT_DAY_FINAL_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM events WHERE id='$EVENT_DAY_EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$EVENT_DAY_FINAL_STATUS" = 'completed' ] || { echo "event lifecycle did not become completed: $EVENT_DAY_FINAL_STATUS"; exit 1; }
echo OK

printf '90/90 verify all generated domain events were acknowledged... ' 
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
