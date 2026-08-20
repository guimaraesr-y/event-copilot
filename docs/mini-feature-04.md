# Mini-feature 04 — Domain Event Gateway + first n8n workflow

## Goal

Turn the transactional outbox into a real orchestration boundary. Domain events are delivered at-least-once to n8n, authenticated with a short-lived HMAC signature, and only marked dispatched after the n8n workflow completes successfully.

## Delivery contract

The worker sends a versioned envelope:

```json
{
  "schemaVersion": 1,
  "id": "<outbox uuid>",
  "organizationId": "<organization uuid>",
  "eventType": "vendor.confirmation_requested",
  "aggregateType": "event_vendor",
  "aggregateId": "<event vendor uuid>",
  "occurredAt": "2026-08-09T17:00:00.000Z",
  "payload": {}
}
```

Headers:

- `x-ecc-timestamp`: Unix seconds
- `x-ecc-signature`: `sha256=<HMAC-SHA256>`
- `x-ecc-event-id`: outbox event id for observability

The signed message is `${timestamp}.${canonicalEnvelope}`. The API rejects signatures older than five minutes and checks that the envelope matches an existing transactional-outbox row.

## n8n workflow

`n8n/workflows/ecc-domain-event-gateway.json`

```text
Webhook
  ↓
Verify Domain Event (API)
  ↓
Is vendor.confirmation_requested?
  ├─ no  → acknowledged/no-op
  └─ yes → Prepare Vendor Confirmation (API)
```

The Webhook uses `responseMode=lastNode`, so the outbox worker only receives a successful HTTP response after downstream processing succeeds.

## First real automation effect

For `vendor.confirmation_requested`, n8n creates an idempotent `automation_actions` record:

```text
action_type = vendor_confirmation.prepare
status      = prepared
```

`(source_outbox_event_id, action_type)` is unique. If the worker retries after a response is lost, n8n can execute again without creating a duplicate action.

Mini-feature 05 will consume this prepared action to compose/send the actual WhatsApp confirmation message.

## Network boundary

The n8n webhook and API `/internal` routes are intentionally blocked by Caddy. They are only used through the Docker network (`worker → n8n → api`). HMAC remains mandatory even inside that network.

## Syncing the workflow

O stack local faz o primeiro deploy automaticamente através do serviço one-shot `n8n-init` do Compose. Em uma instância n8n vazia, ele importa e publica o workflow antes do runtime e do worker iniciarem.

Para republicar uma alteração do JSON com o stack já rodando:

```bash
./scripts/n8n-sync.sh
```

The script uses the official n8n CLI to import the JSON and `publish:workflow` to make the production webhook live.
