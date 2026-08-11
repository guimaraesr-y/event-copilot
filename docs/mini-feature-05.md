# Mini-feature 05 — Outbound Messaging + WhatsApp

> **Superseded webhook boundary:** Mini-feature 05.1 replaces the provider-status n8n workflow described below with the generic API endpoint `/api/v1/messaging/webhooks/:provider` and provider adapters. The outbound lifecycle from this slice remains valid.


This slice turns `vendor.confirmation_requested` into a durable outbound WhatsApp message.

## Runtime path

`VendorEngine -> outbox -> worker -> n8n -> automation_action -> outbound_message -> provider`

The domain-event workflow only returns success after the provider send finishes. The default provider is `mock`, so the local smoke test never depends on Meta credentials.

## Message lifecycle

`pending -> sending -> sent -> delivered -> read`

`failed` is explicit and retryable by the send claim. A unique `source_action_id` makes message creation idempotent, and `pending/failed -> sending` is an atomic database claim so concurrent workflow retries cannot both invoke the provider.

## Providers

- `WHATSAPP_PROVIDER=mock`: returns `mock-wamid-<message-id>`.
- `WHATSAPP_PROVIDER=meta`: calls the configured Meta Graph API. `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `META_GRAPH_API_VERSION` are required.

The actual message text is deterministic, not LLM-generated.

## Status ingress

`ECC - WhatsApp Status Gateway` accepts a provider-neutral signed payload and forwards it to the internal API. Mini-feature 05 uses an ECC HMAC contract for the mock/provider adapter. A native Meta webhook verification adapter can be layered on later without changing `MessagingEngine` or `outbound_messages`.

## Safety / idempotency

- one outbound message per automation action;
- one external id per provider;
- monotonic `sent -> delivered -> read` tracking;
- late duplicate status callbacks are no-ops;
- internal messaging endpoints stay behind the Docker network/Caddy boundary;
- the public provider-status webhook must carry a valid timestamped HMAC.

A crash after an external provider accepts a message but before the local `sent` transaction commits is intentionally **not** auto-reclaimed from `sending`; automatically retrying that ambiguous state could send a duplicate message. This state should be reconciled explicitly when a real provider is enabled.
