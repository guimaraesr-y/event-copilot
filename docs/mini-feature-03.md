# Mini-feature 03 — Vendors + Event Vendors + Confirmation State

## Scope

Adds an organization-scoped vendor catalog and event-specific vendor assignments without moving integration logic into the domain.

### Vendor catalog
- `vendors` belongs to one organization.
- Stores stable contact data and category.
- No vendor can cross tenant boundaries.

### Event vendor assignment
- `event_vendors` is the operational snapshot for one event.
- Snapshots vendor name, category and contact details at attachment time.
- Stores arrival/departure, team size, contract/payment state and notes.
- A vendor can be attached only once to the same event.

### Confirmation state machine
`pending -> requested -> confirmed | declined`

`confirmed` or `declined` may also be recorded manually from `pending`. Cancelled assignments reject confirmation actions.

### Domain events
- `vendor.attached`
- `vendor.assignment_updated`
- `vendor.confirmation_requested`
- `vendor.confirmed`
- `vendor.declined`

All event-vendor mutations that emit domain events persist the assignment and outbox record in the same PostgreSQL transaction.

## Why n8n is not sending messages yet

This mini-feature deliberately stops at `vendor.confirmation_requested`. Mini-feature 04 will connect the existing outbox worker to an n8n domain-event gateway. The eventual n8n workflow will receive the event, choose the channel and send the external message without owning confirmation state.
