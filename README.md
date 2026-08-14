# Event Command Center

Current version: **0.7.0 — Operational Inbox + Activity Log**.

The Event Command Center is being built as a vertical event-operations backend. PostgreSQL is the source of truth, domain engines own business transitions, the transactional outbox provides durable domain events, and n8n orchestrates external effects.

## Current flow

```text
Event / Vendor / Messaging / Inbound Engines
                 ↓
          PostgreSQL + Outbox
                 ↓
               Worker
          ┌──────┴──────┐
          ↓             ↓
Operational Projector   n8n
          ↓             ↓
 Activity / Inbox    External effects
```

Messaging uses a provider-neutral boundary:

```text
Provider webhook
      ↓
/api/v1/messaging/webhooks/:provider
      ↓
MessagingWebhookAdapter (mock | meta)
      ↓
Canonical event
      ↓
MessagingEngine
```

## Implemented slices

1. Foundation + Event + Transactional Outbox
2. Event Templates + Tasks/Milestones
3. Vendors + Event Vendors + Confirmation State
4. n8n Domain Event Gateway
5. Durable Outbound Messaging
5.1 Generic Messaging Webhooks (`mock | meta`)
6. Supplier Inbound + deterministic response resolution
7. Operational Inbox + Activity Log

## Feature 07

Operational projections are created internally by the worker before n8n delivery. They are idempotent by the source outbox event.

Activity timeline:

```text
GET /api/v1/events/:eventId/activity
```

Operational inbox:

```text
GET  /api/v1/inbox
GET  /api/v1/inbox/:itemId
POST /api/v1/inbox/:itemId/resolve
POST /api/v1/inbox/:itemId/dismiss
```

Initial inbox triggers:

- supplier response requires review;
- outbound message failed;
- vendor declined the event.

See `docs/mini-feature-07.md` for the detailed contract.

## Local development

```bash
cp .env.example .env
docker compose up --build -d
./scripts/n8n-sync.sh
```

## Full deterministic smoke

The smoke environment is isolated from your normal `.env`, Meta credentials, database and n8n volumes:

```bash
./scripts/smoke-env.sh
```

It uses:

```text
COMPOSE_PROJECT_NAME=event-command-center-smoke
GATEWAY_PORT=18080
WHATSAPP_PROVIDER=mock
```

By default the dedicated smoke volumes are reset before every run. To preserve them for debugging:

```bash
SMOKE_RESET=0 ./scripts/smoke-env.sh
```

The full smoke currently covers foundation through Feature 07, including supplier confirmation, outbound/inbound messaging, activity projection, ambiguous-response inbox creation and inbox resolution.

## Meta WhatsApp

For a real local Meta test use the normal `.env` with `WHATSAPP_PROVIDER=meta`. The public callback remains:

```text
GET/POST /api/v1/messaging/webhooks/meta
```

n8n never parses Meta-specific webhook payloads.

## Validation

```bash
python3 scripts/validate_foundation.py
python3 scripts/validate_feature_07.py
```

Docker runtime validation is performed locally through `./scripts/smoke-env.sh` because Docker is not available in the artifact-generation environment.
