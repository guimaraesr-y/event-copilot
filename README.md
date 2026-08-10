# Event Command Center — Mini-feature 04

**Domain Event Gateway + first real n8n workflow**, built on the Foundation, Event Planning and Vendor slices.

PostgreSQL remains the source of truth, the backend owns business rules, and n8n is now an active orchestration boundary rather than a dormant container.

## What this slice adds

- versioned domain-event envelope (`schemaVersion: 1`)
- HMAC-SHA256 signing between the outbox worker and the ECC integration boundary
- five-minute replay window for signatures
- validation that delivered envelopes correspond to real outbox rows
- `OUTBOX_TRANSPORT=n8n` as the Compose default
- first importable/publishable n8n workflow
- `automation_actions`
- idempotent `vendor_confirmation.prepare`
- internal-only n8n webhook/API routes at the Caddy boundary
- n8n workflow sync script using `import:workflow` + `publish:workflow`
- runtime smoke covering the complete `outbox → n8n → API → automation_actions` round-trip

## Delivery semantics

```text
Business transaction
      ↓
transactional outbox
      ↓
worker claims event
      ↓
HMAC signed envelope
      ↓
n8n Webhook
      ↓
API verifies signature + outbox identity
      ↓
n8n routes event
      ↓
automation action prepared
      ↓
n8n HTTP 2xx
      ↓
worker sets dispatched_at
```

This is **at-least-once delivery**. Side effects must therefore be idempotent. The first action is protected by:

```text
UNIQUE(source_outbox_event_id, action_type)
```

## First workflow

For ordinary domain events the gateway authenticates and acknowledges them. For:

```text
vendor.confirmation_requested
```

it prepares:

```text
vendor_confirmation.prepare
```

That row is the handoff point for Mini-feature 05, where the real WhatsApp message will be composed and sent.

## Run

Existing database:

```bash
docker compose up --build -d
```

Fresh environment:

```bash
cp .env.example .env
docker compose up --build -d
```

Install/publish the n8n workflow:

```bash
./scripts/n8n-sync.sh
```

Or run the full smoke; it syncs the workflow automatically:

```bash
./scripts/smoke.sh
```

The smoke still intentionally creates fresh test data on every run.

## Security

Generate a real secret before non-local use:

```bash
openssl rand -hex 32
```

Set it as `DOMAIN_EVENT_SHARED_SECRET` for both API and worker. The secret is never stored in the n8n workflow.

`x-organization-id` is still development-only tenancy context and is not authentication.

## Validation

Static/core regression:

```bash
python3 scripts/validate_feature_04.py
```

Runtime integration:

```bash
./scripts/smoke.sh
```

The packaging environment does not provide Docker or Bun, so container startup and real n8n execution remain covered by the included smoke test on a Docker-enabled machine.

## Next slice

**Mini-feature 05 — WhatsApp Business + Vendor Confirmation delivery.**

It will turn `vendor_confirmation.prepare` into an outbound message, record delivery state and begin processing supplier replies.

## Mini-feature 05 — Outbound Messaging

`vendor.confirmation_requested` now traverses the complete durable path through n8n and creates/sends exactly one `outbound_messages` record. Local development uses `WHATSAPP_PROVIDER=mock`; see `docs/mini-feature-05.md` for the provider and status contracts.

Run the full local integration smoke with:

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke.sh
```
