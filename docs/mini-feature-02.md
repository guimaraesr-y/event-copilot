# Mini-feature 02 — Event Templates + Tasks/Milestones

## Goal

A newly created event can optionally reference an organization-owned template. The template is read as a snapshot, transformed into concrete event tasks and milestones, and persisted atomically with the event and its domain events.

## Invariants

1. A template can only be used by the organization that owns it.
2. Template `eventType` must match the new event `type`.
3. Template changes after event creation never mutate the event plan.
4. Event, instantiated tasks, instantiated milestones and outbox messages are written in one PostgreSQL transaction.
5. Relative dates are calendar dates in the organization timezone, not simple 24-hour subtraction from the UTC event instant.
6. The event still supports creation without a template.

## Date example

Organization timezone: `America/Sao_Paulo`

Event local start: `2026-10-17 17:30 -03:00`

- D-30 at 09:00 => `2026-09-17T12:00:00.000Z`
- D-7 at 10:00 => `2026-10-10T13:00:00.000Z`
- D-1 at 18:00 => `2026-10-16T21:00:00.000Z`

## Domain events

Creating an event always writes:

- `event.created`

Creating from a template also writes:

- `event.plan_initialized`

Manual tasks write:

- `task.created`
- `task.updated`
- `task.completed`

All are persisted through the same transactional outbox mechanism established in mini-feature 01.

## API surface

### Templates

- `POST /api/v1/event-templates`
- `GET /api/v1/event-templates`
- `GET /api/v1/event-templates/:id`
- `POST /api/v1/event-templates/:id/tasks`
- `DELETE /api/v1/event-templates/:templateId/tasks/:taskId`
- `POST /api/v1/event-templates/:id/milestones`
- `DELETE /api/v1/event-templates/:templateId/milestones/:milestoneId`

### Event planning

- `POST /api/v1/events` (`templateId` is optional)
- `GET /api/v1/events/:id/tasks`
- `POST /api/v1/events/:id/tasks`
- `PATCH /api/v1/events/:eventId/tasks/:taskId`
- `GET /api/v1/events/:id/milestones`

The existing temporary tenancy contract remains unchanged: `x-organization-id` is required for business endpoints but is not authentication.
