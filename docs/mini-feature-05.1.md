# Mini-feature 05.1 — Generic Messaging Webhooks

This refinement keeps the outbound messaging slice from Mini-feature 05 and removes provider-specific webhook parsing from n8n.

## Goal

The ECC domain consumes one canonical webhook model regardless of the external messaging provider.

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
Postgres / Transactional Outbox
  ↓
n8n Domain Event Gateway
```

## Supported providers

- `mock` — deterministic local smoke/testing provider.
- `meta` — Meta WhatsApp Cloud API.

## Provider boundary

Outbound sending and inbound webhook parsing remain separate responsibilities:

```ts
interface MessagingProvider {
  send(message: OutboundMessage): Promise<SendResult>
}

interface MessagingWebhookAdapter {
  readonly provider: MessageProviderName
  verify(request: MessagingWebhookRequest): void
  parse(request: MessagingWebhookRequest): CanonicalMessagingWebhookEvent[]
  challenge?(query: Record<string, string | undefined>): string | null
}
```

This prevents Meta-specific request shapes and signatures from leaking into the domain or n8n workflows.

## Canonical events

Webhook adapters normalize external payloads into:

- `message.status`
- `message.received`

`message.received` is persisted now but intentionally not consumed by business logic until Mini-feature 06.

## Verification

### Mock

The mock adapter uses the ECC shared webhook secret with timestamped HMAC-SHA256.

### Meta

The Meta adapter:

- handles the GET verification challenge;
- verifies `X-Hub-Signature-256` over the exact raw request body;
- normalizes WhatsApp Cloud status callbacks and inbound messages.

## Idempotency

Migration `006_messaging_webhooks` adds `messaging_webhook_events`. A compatibility migration, `007_restrict_messaging_providers`, reapplies the current provider boundary for installations that had already executed an earlier 05.1 build. Idempotency remains:

```text
UNIQUE(provider, external_event_id)
```

`processed` is terminal. Status events that were temporarily `ignored` or `failed` remain safe to retry so a provider callback that races local persistence is not lost.

## n8n

n8n no longer parses provider callbacks. Provider-specific payloads enter the API boundary first. n8n receives only ECC domain events through `ECC - Domain Event Gateway`.
