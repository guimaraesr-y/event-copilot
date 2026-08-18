# Mini-feature 10 — Change Proposals

## Goal

Allow the Operational Agent and REST API to handle sensitive event changes without giving the AI direct mutation capabilities.

Supported changes:

- event date;
- event start time;
- guest count;
- venue name/address.

## Safety invariant

A request to change sensitive event data always has two separate state transitions:

```text
request → proposed
explicit approval → applied
```

Creating a proposal never mutates the `events` row.

Approval is atomic: the proposal status, event mutation and outbox events are written in one PostgreSQL transaction.

## Tables

### `change_proposals`

Stores tenant/event ownership, requesting sender, optional source Agent turn, idempotency key, current/proposed values, reason and decision timestamps.

Statuses:

```text
proposed
applied
rejected
cancelled
```

### `change_proposal_impacts`

Stores deterministic impact analysis with:

```text
category
severity
title
description
metadata
```

Impact categories currently cover schedule, vendor, task, milestone, guest, venue and logistics.

## Agent tools

Read:

```text
get_change_proposals
```

Proposal creation:

```text
propose_event_date_change
propose_event_time_change
propose_guest_count_change
propose_venue_change
```

Decision:

```text
approve_change_proposal
reject_change_proposal
```

The server independently checks that approval/rejection messages are explicit. A model cannot silently call the approval tool from an unrelated message.

## Conversational approval

Pending proposals requested by the current sender are included in the Agent runtime context. This allows a short second turn:

```text
Planner: Mude o horário do casamento para 17h.
ECC: Proposta criada ... Deseja aprovar essa alteração?
Planner: sim
ECC: Alteração aprovada e aplicada ...
```

The proposal UUID stays internal to the tool loop.

## Operational projection

`change.proposed`:

- creates an Activity entry;
- creates an Operational Inbox item awaiting approval.

`change.applied`:

- creates an Activity entry;
- resolves the proposal Inbox item.

`change.rejected`:

- creates an Activity entry;
- dismisses the proposal Inbox item.

## Domain events

```text
change.proposed
change.applied
change.rejected
event.updated
```

## Important current limitation

Applying a date/time change updates the event itself but intentionally does not cascade schedule changes into tasks, milestones or vendor arrival/departure timestamps.

Those possible consequences are surfaced as impacts. Automatic cascades belong to the future Dependency Engine, where dependency rules can be modeled explicitly instead of being hidden inside Change Proposals.

## REST examples

Create a guest-count proposal:

```bash
curl -X POST "$BASE_URL/api/v1/events/$EVENT_ID/change-proposals" \
  -H "x-organization-id: $ORG_ID" \
  -H 'content-type: application/json' \
  -d '{
    "sender":"planner-1",
    "idempotencyKey":"guest-change-001",
    "type":"guest_count",
    "proposedValue":{"guestCount":180}
  }'
```

Approve:

```bash
curl -X POST "$BASE_URL/api/v1/change-proposals/$PROPOSAL_ID/approve" \
  -H "x-organization-id: $ORG_ID" \
  -H 'content-type: application/json' \
  -d '{"sender":"planner-1"}'
```

Reject:

```bash
curl -X POST "$BASE_URL/api/v1/change-proposals/$PROPOSAL_ID/reject" \
  -H "x-organization-id: $ORG_ID" \
  -H 'content-type: application/json' \
  -d '{"sender":"planner-1","reason":"cliente desistiu da mudança"}'
```

## Smoke

Steps 43–49 cover Change Proposals and step 50 validates that all resulting domain events were dispatched.
