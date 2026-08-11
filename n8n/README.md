# n8n workflows

n8n is the orchestration layer, not the messaging-provider webhook parser.

## Published workflow

- `ECC - Domain Event Gateway`: consumes signed ECC outbox events.
  - `vendor.confirmation_requested` prepares and sends the outbound vendor-confirmation message.
  - other verified domain events are explicitly acknowledged.

## Generic messaging webhooks

Provider callbacks do **not** enter n8n first.

They are received by:

`POST /api/v1/messaging/webhooks/:provider`

The API preserves the raw request body, delegates verification/parsing to the selected adapter (`mock` or `meta`), persists the canonical webhook event idempotently, and lets the `MessagingEngine` apply status transitions.

Any resulting ECC domain events (`message.delivered`, `message.read`, etc.) return to n8n through the regular Domain Event Gateway.

This keeps provider-specific payloads and signatures out of workflows and makes inbound messaging reusable for Feature 06.
