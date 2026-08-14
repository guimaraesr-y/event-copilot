# Mini-feature 07 — Operational Inbox + Activity Log

## Goal
Turn durable domain events into an operational view that a cerimonial team can consume without reading technical tables such as `outbox_events`, `automation_actions`, or messaging receipts.

## Internal projection path

```text
Domain Engine
  ↓
Transactional Outbox
  ↓
Worker claim
  ↓
OperationalProjector
  ↓
activity_entries / inbox_items
  ↓
n8n external orchestration
  ↓
outbox dispatched
```

Projection happens before the external transport. It is idempotent by source outbox event, so at-least-once retries do not duplicate timeline or inbox records.

## Activity whitelist

The first operational timeline projects:

- `event.created`
- `vendor.attached`
- `vendor.confirmation_requested`
- `vendor.confirmed`
- `vendor.declined`
- `message.received`
- `task.completed`

Transport noise such as `message.delivered` and `message.read` remains available in messaging tables but is intentionally not copied into the main event timeline.

## Inbox rules

The first inbox sources are:

- `vendor.declined` → critical
- `message.failed` → warning
- `message.review_required` → warning

`message.review_required` is emitted both for ambiguous supplier correlation and for uniquely-correlated replies that the deterministic interpreter cannot safely process.

Cross-tenant ambiguity is split into one review domain event per organization. Each payload only contains candidate IDs owned by that organization.

## Persistence

Migration `009_operational_inbox_activity` creates:

- `activity_entries`
- `inbox_items`

Idempotency:

```text
activity_entries: UNIQUE(source_event_id)
inbox_items:      UNIQUE(source_event_id, type)
```

## API

```text
GET  /api/v1/events/:eventId/activity
GET  /api/v1/inbox
GET  /api/v1/inbox/:itemId
POST /api/v1/inbox/:itemId/resolve
POST /api/v1/inbox/:itemId/dismiss
```

Supported filters:

```text
/activity?category=vendor&limit=50
/inbox?status=open&severity=critical&eventId=<uuid>&limit=50
```

`x-organization-id` remains the temporary tenancy boundary and is not authentication.

## Current limitation

There is intentionally no historical backfill for already-dispatched outbox rows. Operational projection starts for domain events processed after migration 009. A dedicated rebuild/backfill mechanism can be added later if needed.
