# Event Command Center

Mini-feature **05.1 — Generic Messaging Webhooks**, built on the durable outbound-messaging slice.

## Current architecture

```text
Event/Vendor Engine
  ↓
Transactional Outbox
  ↓
Worker
  ↓
n8n Domain Event Gateway
  ↓
Automation Action
  ↓
OutboundMessage
  ↓
MessagingProvider (mock | meta)
```

Provider callbacks use the opposite boundary:

```text
Provider
  ↓
POST /api/v1/messaging/webhooks/:provider
  ↓
MessagingWebhookAdapter
  ↓
CanonicalMessagingWebhookEvent
  ↓
MessagingEngine
  ↓
Postgres / Outbox
```

n8n is an orchestrator. It does not parse provider-specific webhook payloads.

## Supported messaging providers

- `mock` — deterministic local/smoke provider.
- `meta` — Meta WhatsApp Cloud API.

Set:

```env
WHATSAPP_PROVIDER=mock
```

for local development.

## Generic webhook endpoint

```text
GET  /api/v1/messaging/webhooks/:provider
POST /api/v1/messaging/webhooks/:provider
```

`GET` is used only by providers that require verification challenges, such as Meta.

`POST` preserves the exact raw body before delegating to a `MessagingWebhookAdapter`.

Adapters currently implemented:

- `MockMessagingWebhookAdapter`
- `MetaWhatsAppWebhookAdapter`

The domain only receives canonical events:

```text
message.status
message.received
```

`message.received` is already normalized and durably persisted but is intentionally left for Mini-feature 06.

## Webhook durability

Migration `006_messaging_webhooks` creates `messaging_webhook_events`. Migration `007_restrict_messaging_providers` keeps upgrades from earlier 05.1 builds restricted to the current provider set. Webhook idempotency is enforced by:

```text
UNIQUE(provider, external_event_id)
```

This makes provider retries idempotent.

A status receipt that is already `processed` is terminal. `ignored`/`failed` status receipts can be retried so an early callback is not lost if it arrives before `external_message_id` is committed.

## Meta configuration

For real Meta WhatsApp Cloud usage:

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
META_GRAPH_API_VERSION=
META_GRAPH_API_BASE_URL=https://graph.facebook.com
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
```

Configure the Meta webhook against:

```text
https://<your-host>/api/v1/messaging/webhooks/meta
```

## Local validation

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke.sh
```

The smoke uses `mock`, so no external WhatsApp account is required.

The n8n workflow is imported/published by:

```bash
./scripts/n8n-sync.sh
```

## Important boundary

Postgres is the source of truth. Business state transitions belong to the backend. n8n performs orchestration and external integration, while provider adapters own provider-specific verification and normalization.
