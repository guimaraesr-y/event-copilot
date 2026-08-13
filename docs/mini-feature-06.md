# Mini-feature 06 — Supplier Inbound + Resolution

## Goal
Close the supplier-confirmation loop for text replies without an LLM. A provider webhook is normalized by the generic messaging boundary, correlated to one pending event-vendor confirmation, persisted as `inbound_messages`, emitted as `message.received`, processed by n8n, and applied through `VendorEngine`.

## Safety rules
- exactly one recent pending confirmation -> `resolved` and `message.received` outbox event
- zero candidates -> `ignored`
- multiple candidates -> `needs_review`; never guess an event
- media -> `needs_review` in v0.6
- unknown/undecided text -> `needs_review`
- processed inbound messages are idempotent
- `VendorEngine.confirm/decline` are retry-safe for identical terminal state

## Rule-based interpreter
Recognizes explicit confirmation/decline, `HH:mm`, `14h30`, `14h`, and team sizes such as `3 pessoas`, `equipe de 3`, `somos 3`. Operational details in direct response to a pending confirmation imply confirmation.

## Persistence
Migration `008_supplier_inbound` adds `inbound_messages` with provider/external-message idempotency, resolution context, candidates, interpretation, processing status, and audit fields.
