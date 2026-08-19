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

printf '1/55 readiness... '
curl -fsS "$BASE_URL/api/health/ready" >/dev/null
echo OK

printf '2/55 install and publish n8n workflow... '
if N8N_SYNC_OUTPUT=$(./scripts/n8n-sync.sh 2>&1); then
  echo OK
else
  echo FAILED
  printf '%s\n' "$N8N_SYNC_OUTPUT" >&2
  exit 1
fi

printf '3/55 create organization... '
ORG_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/organizations" -H 'content-type: application/json' -d '{"name":"Cerimonial Demo","timezone":"America/Sao_Paulo"}')
ORG_ID=$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ORG_ID" ] || { echo 'could not extract organization id'; exit 1; }
echo "$ORG_ID"

printf '4/55 create wedding template... '
TEMPLATE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/event-templates" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Casamento Padrão Smoke","eventType":"wedding"}')
TEMPLATE_ID=$(printf '%s' "$TEMPLATE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$TEMPLATE_ID" ] || { echo 'could not extract template id'; exit 1; }
echo "$TEMPLATE_ID"

printf '5/55 add template plan... '
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Fechar RSVP","offsetDays":-30,"dueTime":"09:00","priority":"high","type":"guest"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/tasks" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"title":"Confirmar fornecedores","offsetDays":-7,"dueTime":"10:00","priority":"critical","type":"confirmation"}' >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/event-templates/$TEMPLATE_ID/milestones" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Checklist final","offsetDays":-1,"dueTime":"18:00"}' >/dev/null
echo OK

printf '6/55 create event from template... '
EVENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"name\":\"Ana & Pedro\",\"type\":\"wedding\",\"templateId\":\"$TEMPLATE_ID\",\"startAt\":\"2026-10-17T17:30:00-03:00\",\"guestCount\":132}")
EVENT_ID=$(printf '%s' "$EVENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$EVENT_ID" ] || { echo 'could not extract event id'; exit 1; }
echo "$EVENT_ID"

printf '7/55 verify event plan regression... '
TASKS_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/tasks" -H "x-organization-id: $ORG_ID")
printf '%s' "$TASKS_JSON" | grep -q '2026-09-17T12:00:00.000Z' || { echo 'D-30 date mismatch'; exit 1; }
printf '%s' "$TASKS_JSON" | grep -q '2026-10-10T13:00:00.000Z' || { echo 'D-7 date mismatch'; exit 1; }
echo OK

printf '8/55 create vendor catalog entry... '
VENDOR_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"name":"Luz Foto","category":"photo","contactName":"Carla","phone":"+5521999999999","email":"foto@example.com"}')
VENDOR_ID=$(printf '%s' "$VENDOR_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$VENDOR_ID" ] || { echo 'could not extract vendor id'; exit 1; }
echo "$VENDOR_ID"

printf '9/55 attach vendor to event... '
ASSIGNMENT_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"vendorId\":\"$VENDOR_ID\",\"contractStatus\":\"signed\",\"paymentStatus\":\"partial\"}")
ASSIGNMENT_ID=$(printf '%s' "$ASSIGNMENT_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ASSIGNMENT_ID" ] || { echo 'could not extract event vendor id'; exit 1; }
echo "$ASSIGNMENT_ID"

printf '10/55 request vendor confirmation... '
REQUEST_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/vendors/$ASSIGNMENT_ID/confirmation-request" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"deadlineAt":"2026-10-10T09:00:00-03:00"}')
printf '%s' "$REQUEST_JSON" | grep -q '"confirmationStatus":"requested"' || { echo 'confirmation request state mismatch'; exit 1; }
echo OK

printf '11/55 verify n8n created and sent one outbound message... '
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

printf '12/55 verify outbound idempotency... '
MESSAGE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbound_messages WHERE aggregate_id='$ASSIGNMENT_ID'::uuid AND message_type='vendor_confirmation';\"" | tr -d '\r[:space:]')
[ "$MESSAGE_COUNT" = '1' ] || { echo "expected 1 outbound message, got $MESSAGE_COUNT"; exit 1; }
echo OK

DELIVERED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
READ_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

printf '13/55 simulate delivered through generic messaging webhook... '
post_mock_provider_status "$EXTERNAL_ID" delivered "$DELIVERED_AT"
echo OK

printf '14/55 verify delivered tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'delivered' ] || { echo "expected delivered, got $STATUS"; exit 1; }
echo OK

printf '15/55 simulate read through generic messaging webhook... '
post_mock_provider_status "$EXTERNAL_ID" read "$READ_AT"
echo OK

printf '16/55 verify read tracking... '
STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM outbound_messages WHERE id='$MESSAGE_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$STATUS" = 'read' ] || { echo "expected read, got $STATUS"; exit 1; }
echo OK

printf '17/55 verify provider webhook idempotency... '
post_mock_provider_status "$EXTERNAL_ID" read "$READ_AT"
WEBHOOK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM messaging_webhook_events WHERE provider='mock' AND external_event_id='mock:$EXTERNAL_ID:read:$READ_AT';\"" | tr -d '\r[:space:]')
[ "$WEBHOOK_COUNT" = '1' ] || { echo "expected one canonical webhook receipt, got $WEBHOOK_COUNT"; exit 1; }
echo OK

printf '18/55 simulate supplier inbound confirmation... '
INBOUND_EXTERNAL_ID="mock-inbound-$ASSIGNMENT_ID"
# Keep the simulated reply strictly after the outbound send timestamp.
sleep 1
INBOUND_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
post_mock_inbound_message "$INBOUND_EXTERNAL_ID" '5521999999999' 'Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.' "$INBOUND_AT"
echo OK

printf '19/55 verify inbound message persisted and correlated... '
ATTEMPT=0
INBOUND_ROW=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  INBOUND_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,status,resolved_event_vendor_id FROM inbound_messages WHERE provider='mock' AND external_message_id='$INBOUND_EXTERNAL_ID';\"" 2>/dev/null | tr -d '\r')
  if printf '%s' "$INBOUND_ROW" | grep -q "|processed|$ASSIGNMENT_ID$"; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$INBOUND_ROW" | grep -q "|processed|$ASSIGNMENT_ID$" || { echo "inbound message was not processed: $INBOUND_ROW"; exit 1; }
INBOUND_ID=$(printf '%s' "$INBOUND_ROW" | cut -d'|' -f1)

printf '20/55 verify supplier response updated vendor assignment... '
VENDOR_STATE=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT confirmation_status,(arrival_at = '2026-10-17T17:30:00Z'::timestamptz),team_size FROM event_vendors WHERE id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$VENDOR_STATE" | grep -q '^confirmed|t|3$' || { echo "unexpected vendor state: $VENDOR_STATE"; exit 1; }
echo OK

printf '21/55 verify inbound webhook/process idempotency... '
post_mock_inbound_message "$INBOUND_EXTERNAL_ID" '5521999999999' 'Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.' "$INBOUND_AT"
INBOUND_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbound_messages WHERE provider='mock' AND external_message_id='$INBOUND_EXTERNAL_ID';\"" | tr -d '\r[:space:]')
CONFIRMED_EVENTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE organization_id='$ORG_ID'::uuid AND event_type='vendor.confirmed' AND aggregate_id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$INBOUND_COUNT" = '1' ] || { echo "expected one inbound message, got $INBOUND_COUNT"; exit 1; }
[ "$CONFIRMED_EVENTS" = '1' ] || { echo "expected one vendor.confirmed event, got $CONFIRMED_EVENTS"; exit 1; }
echo OK

printf '22/55 verify event activity timeline... '
ATTEMPT=0
ACTIVITY_JSON=''
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  ACTIVITY_JSON=$(curl -fsS "$BASE_URL/api/v1/events/$EVENT_ID/activity" -H "x-organization-id: $ORG_ID")
  if printf '%s' "$ACTIVITY_JSON" | grep -q 'vendor.confirmed' && printf '%s' "$ACTIVITY_JSON" | grep -q 'message.received'; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
printf '%s' "$ACTIVITY_JSON" | grep -q 'vendor.confirmed' || { echo 'vendor.confirmed missing from activity timeline'; exit 1; }
printf '%s' "$ACTIVITY_JSON" | grep -q 'message.received' || { echo 'message.received missing from activity timeline'; exit 1; }

printf '23/55 verify activity projection idempotency... '
CONFIRMED_ACTIVITY_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action='vendor.confirmed';\"" | tr -d '\r[:space:]')
[ "$CONFIRMED_ACTIVITY_COUNT" = '1' ] || { echo "expected one vendor.confirmed activity, got $CONFIRMED_ACTIVITY_COUNT"; exit 1; }
echo OK

printf '24/55 create two pending confirmation contexts for ambiguity... '
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

printf '25/55 simulate ambiguous supplier response... '
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

printf '26/55 verify operational inbox item... '
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

printf '27/55 resolve inbox item... '
RESOLVE_JSON=$(curl -fsS -X POST "$BASE_URL/api/v1/inbox/$INBOX_ID/resolve" -H "x-organization-id: $ORG_ID")
printf '%s' "$RESOLVE_JSON" | grep -q '"status":"resolved"' || { echo 'inbox item was not resolved'; exit 1; }
echo OK

printf '28/55 select planner event context through rule-based command... '
PLANNER_SENDER='planner-smoke'
CTX_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Selecione o evento Ana & Pedro\",\"idempotencyKey\":\"smoke-context-1\"}")
printf '%s' "$CTX_COMMAND" | grep -q '"intent":"SET_CURRENT_EVENT"' || { echo "context command failed: $CTX_COMMAND"; exit 1; }
printf '%s' "$CTX_COMMAND" | grep -q "$EVENT_ID" || { echo 'command did not resolve Ana & Pedro'; exit 1; }
echo OK

printf '29/55 create task from conversational context... '
TASK_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Crie uma tarefa para confirmar o buffet amanha as 10h\",\"idempotencyKey\":\"smoke-command-task-1\"}")
printf '%s' "$TASK_COMMAND" | grep -q '"intent":"CREATE_TASK"' || { echo "create task command failed: $TASK_COMMAND"; exit 1; }
printf '%s' "$TASK_COMMAND" | grep -q '"status":"processed"' || { echo "task command not processed: $TASK_COMMAND"; exit 1; }
COMMAND_REQUEST_ID=$(printf '%s' "$TASK_COMMAND" | sed -n 's/.*"request":{"id":"\([^"]*\)".*/\1/p')
[ -n "$COMMAND_REQUEST_ID" ] || { echo 'could not extract command request id'; exit 1; }
echo OK

printf '30/55 verify command-created task traceability... '
COMMAND_TASK_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT id,title,source,source_command_request_id FROM event_tasks WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND source_command_request_id='$COMMAND_REQUEST_ID'::uuid;\"" | tr -d '\r')
printf '%s' "$COMMAND_TASK_ROW" | grep -q "|confirmar o buffet|automation|$COMMAND_REQUEST_ID$" || { echo "unexpected command task: $COMMAND_TASK_ROW"; exit 1; }
COMMAND_TASK_ID=$(printf '%s' "$COMMAND_TASK_ROW" | cut -d'|' -f1)
echo OK

printf '31/55 query event status using saved conversation context... '
STATUS_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Como esta o evento?\",\"idempotencyKey\":\"smoke-command-status-1\"}")
printf '%s' "$STATUS_COMMAND" | grep -q '"intent":"GET_EVENT_STATUS"' || { echo "status command failed: $STATUS_COMMAND"; exit 1; }
printf '%s' "$STATUS_COMMAND" | grep -q '"name":"Ana & Pedro"' || { echo 'status query lost conversation context'; exit 1; }
echo OK

printf '32/55 complete task through command engine... '
COMPLETE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Conclua a tarefa confirmar o buffet\",\"idempotencyKey\":\"smoke-command-complete-1\"}")
printf '%s' "$COMPLETE_COMMAND" | grep -q '"intent":"COMPLETE_TASK"' || { echo "complete command failed: $COMPLETE_COMMAND"; exit 1; }
TASK_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM event_tasks WHERE id='$COMMAND_TASK_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$TASK_STATUS" = 'completed' ] || { echo "expected completed task, got $TASK_STATUS"; exit 1; }
echo OK

printf '33/55 add event note through command engine... '
NOTE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Adicione uma observacao dizendo que a avo da noiva precisa de acesso facilitado\",\"idempotencyKey\":\"smoke-command-note-1\"}")
printf '%s' "$NOTE_COMMAND" | grep -q '"intent":"ADD_EVENT_NOTE"' || { echo "note command failed: $NOTE_COMMAND"; exit 1; }
NOTE_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_notes WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND body ILIKE '%acesso facilitado%';\"" | tr -d '\r[:space:]')
[ "$NOTE_COUNT" = '1' ] || { echo "expected one command note, got $NOTE_COUNT"; exit 1; }
echo OK

printf '34/55 verify command activity projection... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  COMMAND_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND event_id='$EVENT_ID'::uuid AND action IN ('task.created','task.completed','event.note_added');\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${COMMAND_ACTIVITY:-0}" -ge 3 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${COMMAND_ACTIVITY:-0}" -ge 3 ] || { echo "command activities not projected: ${COMMAND_ACTIVITY:-0}"; exit 1; }

printf '35/55 reject sensitive change without mutating event... '
BEFORE_START=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT start_at::text FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r')
SENSITIVE_COMMAND=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Mude o horario do casamento da Ana para 17h\",\"idempotencyKey\":\"smoke-sensitive-1\"}")
printf '%s' "$SENSITIVE_COMMAND" | grep -q '"status":"rejected"' || { echo "sensitive command was not rejected: $SENSITIVE_COMMAND"; exit 1; }
printf '%s' "$SENSITIVE_COMMAND" | grep -q '"requiresChangeProposal":true' || { echo 'change proposal gate missing'; exit 1; }
AFTER_START=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT start_at::text FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r')
[ "$BEFORE_START" = "$AFTER_START" ] || { echo 'sensitive command mutated event'; exit 1; }
echo OK

printf '36/55 verify command idempotency... '
TASK_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/commands" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$PLANNER_SENDER\",\"text\":\"Crie uma tarefa para confirmar o buffet amanha as 10h\",\"idempotencyKey\":\"smoke-command-task-1\"}")
printf '%s' "$TASK_RETRY" | grep -q '"duplicate":true' || { echo "command retry was not idempotent: $TASK_RETRY"; exit 1; }
COMMAND_TASK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_tasks WHERE source_command_request_id='$COMMAND_REQUEST_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$COMMAND_TASK_COUNT" = '1' ] || { echo "expected one task for command request, got $COMMAND_TASK_COUNT"; exit 1; }
echo OK

printf '37/55 verify persisted conversation context... '
CONTEXT_JSON=$(curl -fsS "$BASE_URL/api/v1/command-context?sender=$PLANNER_SENDER" -H "x-organization-id: $ORG_ID")
printf '%s' "$CONTEXT_JSON" | grep -q "$EVENT_ID" || { echo "conversation context mismatch: $CONTEXT_JSON"; exit 1; }
echo OK

printf '38/55 operational agent workspace overview through deterministic smoke provider... '
AGENT_SENDER='planner-agent-smoke'
AGENT_OVERVIEW=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$AGENT_SENDER\",\"text\":\"Como estao meus eventos?\",\"idempotencyKey\":\"smoke-agent-overview-1\"}")
printf '%s' "$AGENT_OVERVIEW" | grep -q '"status":"completed"' || { echo "agent overview failed: $AGENT_OVERVIEW"; exit 1; }
AGENT_OVERVIEW_TURN_ID=$(printf '%s' "$AGENT_OVERVIEW" | sed -n 's/.*"turn":{"id":"\([^"]*\)".*/\1/p')
[ -n "$AGENT_OVERVIEW_TURN_ID" ] || { echo 'could not extract agent overview turn id'; exit 1; }
AGENT_OVERVIEW_TOOL=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT tool_trace->0->>'name' FROM agent_turns WHERE id='$AGENT_OVERVIEW_TURN_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$AGENT_OVERVIEW_TOOL" = 'get_workspace_overview' ] || { echo "expected workspace tool, got $AGENT_OVERVIEW_TOOL"; exit 1; }
echo OK

printf '39/55 operational agent creates task through structured CommandEngine delegation... '
AGENT_TASK=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$AGENT_SENDER\",\"eventId\":\"$EVENT_ID\",\"text\":\"Crie uma tarefa para confirmar o buffet em 2026-10-01T10:00:00-03:00\",\"idempotencyKey\":\"smoke-agent-task-1\"}")
printf '%s' "$AGENT_TASK" | grep -q '"status":"completed"' || { echo "agent task failed: $AGENT_TASK"; exit 1; }
AGENT_TASK_TURN_ID=$(printf '%s' "$AGENT_TASK" | sed -n 's/.*"turn":{"id":"\([^"]*\)".*/\1/p')
[ -n "$AGENT_TASK_TURN_ID" ] || { echo 'could not extract agent task turn id'; exit 1; }
echo OK

printf '40/55 verify agent write used CommandEngine and domain task path... '
AGENT_COMMAND_ROW=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"SELECT cr.id,cr.interpreter,cr.status,et.id,et.source,et.title FROM command_requests cr JOIN event_tasks et ON et.source_command_request_id=cr.id WHERE cr.organization_id='$ORG_ID'::uuid AND cr.idempotency_key LIKE 'agent:$AGENT_TASK_TURN_ID:%:CREATE_TASK' ORDER BY cr.created_at DESC LIMIT 1;\"" | tr -d '\r')
printf '%s' "$AGENT_COMMAND_ROW" | grep -q '|agent|processed|.*|ai|Confirmar buffet$' || { echo "agent command delegation mismatch: $AGENT_COMMAND_ROW"; exit 1; }
echo OK

printf '41/55 verify operational agent turn idempotency... '
AGENT_TASK_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$AGENT_SENDER\",\"eventId\":\"$EVENT_ID\",\"text\":\"Crie uma tarefa para confirmar o buffet em 2026-10-01T10:00:00-03:00\",\"idempotencyKey\":\"smoke-agent-task-1\"}")
printf '%s' "$AGENT_TASK_RETRY" | grep -q '"duplicate":true' || { echo "agent retry was not idempotent: $AGENT_TASK_RETRY"; exit 1; }
AGENT_TASK_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM event_tasks et JOIN command_requests cr ON cr.id=et.source_command_request_id WHERE cr.organization_id='$ORG_ID'::uuid AND cr.idempotency_key LIKE 'agent:$AGENT_TASK_TURN_ID:%:CREATE_TASK';\"" | tr -d '\r[:space:]')
[ "$AGENT_TASK_COUNT" = '1' ] || { echo "expected one agent-created task, got $AGENT_TASK_COUNT"; exit 1; }
echo OK

printf '42/55 verify operational agent conversation history... '
AGENT_HISTORY=$(curl -fsS "$BASE_URL/api/v1/agent/history?sender=$AGENT_SENDER&limit=10" -H "x-organization-id: $ORG_ID")
printf '%s' "$AGENT_HISTORY" | grep -q "$AGENT_OVERVIEW_TURN_ID" || { echo 'overview turn missing from agent history'; exit 1; }
printf '%s' "$AGENT_HISTORY" | grep -q "$AGENT_TASK_TURN_ID" || { echo 'task turn missing from agent history'; exit 1; }
echo OK

printf '43/55 operational agent creates sensitive time change proposal... '
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

printf '44/55 verify proposal impacts and approval inbox projection... '
IMPACT_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM change_proposal_impacts WHERE proposal_id='$CHANGE_PROPOSAL_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "${IMPACT_COUNT:-0}" -ge 1 ] || { echo "proposal impacts missing: $IMPACT_COUNT"; exit 1; }
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  CHANGE_INBOX=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='change_proposal' AND source_id='$CHANGE_PROPOSAL_ID'::uuid AND status='open';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "$CHANGE_INBOX" = '1' ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${CHANGE_INBOX:-0}" = '1' ] || { echo 'change proposal inbox item not projected'; exit 1; }

printf '45/55 approve pending proposal through conversational follow-up... '
AGENT_APPROVE=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"text\":\"sim\",\"idempotencyKey\":\"smoke-agent-change-approve-1\"}")
printf '%s' "$AGENT_APPROVE" | grep -q 'aprovada e aplicada' || { echo "agent approval failed: $AGENT_APPROVE"; exit 1; }
APPLIED_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM change_proposals WHERE id='$CHANGE_PROPOSAL_ID'::uuid;\"" | tr -d '\r[:space:]')
APPLIED_TIME=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT to_char(start_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$APPLIED_STATUS" = 'applied' ] && [ "$APPLIED_TIME" = '17:00' ] || { echo "proposal was not applied correctly: status=$APPLIED_STATUS time=$APPLIED_TIME"; exit 1; }
echo OK

printf '46/55 verify approval idempotency... '
AGENT_APPROVE_RETRY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"text\":\"sim\",\"idempotencyKey\":\"smoke-agent-change-approve-1\"}")
printf '%s' "$AGENT_APPROVE_RETRY" | grep -q '"duplicate":true' || { echo "agent approval retry was not idempotent: $AGENT_APPROVE_RETRY"; exit 1; }
CHANGE_APPLIED_EVENTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM outbox_events WHERE aggregate_id='$CHANGE_PROPOSAL_ID'::uuid AND event_type='change.applied';\"" | tr -d '\r[:space:]')
[ "$CHANGE_APPLIED_EVENTS" = '1' ] || { echo "expected one change.applied event, got $CHANGE_APPLIED_EVENTS"; exit 1; }
echo OK

printf '47/55 verify change activity and inbox resolution... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  CHANGE_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND entity_type='change_proposal' AND entity_id='$CHANGE_PROPOSAL_ID'::uuid AND action IN ('change.proposed','change.applied');\"" 2>/dev/null | tr -d '\r[:space:]')
  CHANGE_INBOX_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='change_proposal' AND source_id='$CHANGE_PROPOSAL_ID'::uuid ORDER BY created_at DESC LIMIT 1;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${CHANGE_ACTIVITY:-0}" -ge 2 ] && [ "$CHANGE_INBOX_STATUS" = 'resolved' ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${CHANGE_ACTIVITY:-0}" -ge 2 ] && [ "$CHANGE_INBOX_STATUS" = 'resolved' ] || { echo "change projection mismatch activity=${CHANGE_ACTIVITY:-0} inbox=$CHANGE_INBOX_STATUS"; exit 1; }

printf '48/55 wait for dependency evaluation after applied time change... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DEP_COUNT=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM dependency_impacts WHERE organization_id='$ORG_ID'::uuid AND proposal_id='$CHANGE_PROPOSAL_ID'::uuid;\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${DEP_COUNT:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${DEP_COUNT:-0}" -ge 1 ] || { echo 'dependency impacts were not generated from change.applied'; exit 1; }

printf '49/55 verify dependency API and inbox projection... '
DEPENDENCIES_JSON=$(curl -fsS "$BASE_URL/api/v1/dependencies?proposalId=$CHANGE_PROPOSAL_ID&status=open" -H "x-organization-id: $ORG_ID")
printf '%s' "$DEPENDENCIES_JSON" | grep -q 'vendor_schedule' || { echo "vendor schedule dependency missing: $DEPENDENCIES_JSON"; exit 1; }
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DEP_INBOX=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='dependency_impact' AND status='open';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${DEP_INBOX:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${DEP_INBOX:-0}" -ge 1 ] || { echo 'dependency inbox item was not projected'; exit 1; }

printf '50/55 apply safe dependency suggestions through conversational agent... '
DEP_APPLY=$(curl -fsS -X POST "$BASE_URL/api/v1/agent/messages" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"$CHANGE_SENDER\",\"text\":\"Recalcule todos os ajustes\",\"idempotencyKey\":\"smoke-agent-dependency-apply-1\"}")
printf '%s' "$DEP_APPLY" | grep -q 'ajuste(s) de dependência aplicado(s)' || { echo "agent dependency apply failed: $DEP_APPLY"; exit 1; }
echo OK

printf '51/55 verify dependency suggestion updated vendor schedule... '
DEP_STATUS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT status FROM dependency_impacts WHERE organization_id='$ORG_ID'::uuid AND proposal_id='$CHANGE_PROPOSAL_ID'::uuid AND dependency_type='vendor_schedule' ORDER BY created_at DESC LIMIT 1;\"" | tr -d '\r[:space:]')
VENDOR_ARRIVAL=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT to_char(arrival_at AT TIME ZONE 'UTC','YYYY-MM-DD\\\"T\\\"HH24:MI:SS\\\"Z\\\"') FROM event_vendors WHERE id='$ASSIGNMENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$DEP_STATUS" = 'applied' ] && [ "$VENDOR_ARRIVAL" = '2026-10-17T17:00:00Z' ] || { echo "dependency application mismatch status=$DEP_STATUS arrival=$VENDOR_ARRIVAL"; exit 1; }
echo OK

printf '52/55 verify dependency activity and inbox resolution... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$OUTBOX_WAIT_SECONDS" ]; do
  DEP_ACTIVITY=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM activity_entries WHERE organization_id='$ORG_ID'::uuid AND action IN ('dependency.evaluation_completed','dependency.applied');\"" 2>/dev/null | tr -d '\r[:space:]')
  DEP_RESOLVED=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM inbox_items WHERE organization_id='$ORG_ID'::uuid AND source_type='dependency_impact' AND status='resolved';\"" 2>/dev/null | tr -d '\r[:space:]')
  if [ "${DEP_ACTIVITY:-0}" -ge 2 ] && [ "${DEP_RESOLVED:-0}" -ge 1 ]; then echo OK; break; fi
  ATTEMPT=$((ATTEMPT + 1)); sleep 1
done
[ "${DEP_ACTIVITY:-0}" -ge 2 ] && [ "${DEP_RESOLVED:-0}" -ge 1 ] || { echo "dependency projection mismatch activity=${DEP_ACTIVITY:-0} resolved=${DEP_RESOLVED:-0}"; exit 1; }

printf '53/55 create guest-count proposal through REST API... '
CURRENT_GUESTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT guest_count FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
TARGET_GUESTS=$((CURRENT_GUESTS + 25))
REST_CHANGE=$(curl -fsS -X POST "$BASE_URL/api/v1/events/$EVENT_ID/change-proposals" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d "{\"sender\":\"planner-rest-smoke\",\"idempotencyKey\":\"smoke-rest-change-1\",\"type\":\"guest_count\",\"proposedValue\":{\"guestCount\":$TARGET_GUESTS}}")
printf '%s' "$REST_CHANGE" | grep -q '"status":"proposed"' || { echo "REST proposal failed: $REST_CHANGE"; exit 1; }
REST_CHANGE_ID=$(printf '%s' "$REST_CHANGE" | sed -n 's/.*"proposal":{"id":"\([^"]*\)".*/\1/p')
[ -n "$REST_CHANGE_ID" ] || { echo 'could not extract REST proposal id'; exit 1; }
echo OK

printf '54/55 reject REST proposal without mutating guest count... '
REST_REJECT=$(curl -fsS -X POST "$BASE_URL/api/v1/change-proposals/$REST_CHANGE_ID/reject" -H 'content-type: application/json' -H "x-organization-id: $ORG_ID" -d '{"sender":"planner-rest-smoke","reason":"smoke rejection"}')
printf '%s' "$REST_REJECT" | grep -q '"status":"rejected"' || { echo "REST reject failed: $REST_REJECT"; exit 1; }
AFTER_REJECT_GUESTS=$(docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT guest_count FROM events WHERE id='$EVENT_ID'::uuid;\"" | tr -d '\r[:space:]')
[ "$AFTER_REJECT_GUESTS" = "$CURRENT_GUESTS" ] || { echo "rejected proposal mutated guest count: before=$CURRENT_GUESTS after=$AFTER_REJECT_GUESTS"; exit 1; }
echo OK

printf '55/55 verify all generated domain events were acknowledged... ' 
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
