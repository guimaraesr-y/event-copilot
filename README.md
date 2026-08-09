# Event Command Center — Mini-feature 02

**Event Templates + automatic Tasks/Milestones**, built on top of mini-feature 01.

The architecture remains intentionally backend-first: PostgreSQL is the source of truth, the backend owns business rules, and n8n is the orchestration boundary for external systems.

## What this slice adds

- `event_templates`
- template tasks with relative `offsetDays` + local `dueTime`
- template milestones
- `events.template_id` traceability
- concrete `event_tasks`
- concrete `event_milestones`
- automatic template instantiation on event creation
- organization-timezone-aware due-date calculation
- `event.plan_initialized` domain event
- manual event task creation/update lifecycle
- `task.created`, `task.updated`, `task.completed`
- tenant-scoped database constraints for planning entities
- updated runtime smoke test

The existing foundation is preserved:

- Bun + TypeScript monorepo
- Hono API
- Kysely + PostgreSQL 18
- transactional outbox
- outbox worker
- n8n with an isolated logical PostgreSQL database
- Caddy gateway
- liveness/readiness checks

## Core behavior

```text
Event Template
    │
    ├── Template Tasks
    └── Template Milestones
             │
             ▼
       POST /events
             │
             ▼
         EventEngine
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
   Event    Tasks  Milestones
     └───────┼────────┘
             ▼
           Outbox
       event.created
 event.plan_initialized
```

All writes above happen in one PostgreSQL transaction.

## Template snapshot rule

Templates are blueprints, not live links.

When an event is created, template tasks/milestones are copied into event-owned rows. Changing or deleting a template task afterward does **not** change the event plan that already exists.

## Timezone semantics

Relative dates are calculated as local calendar dates using `organization.timezone`.

For an event on `17/10/2026` in `America/Sao_Paulo`:

```text
D-30 09:00 -> 17/09/2026 09:00 local -> 2026-09-17T12:00:00.000Z
D-7  10:00 -> 10/10/2026 10:00 local -> 2026-10-10T13:00:00.000Z
D-1  18:00 -> 16/10/2026 18:00 local -> 2026-10-16T21:00:00.000Z
```

See `docs/mini-feature-02.md` for the domain rules.

## Run

For an existing mini-feature 01 database, rebuild the application so the API startup runs migration `002_event_planning` automatically:

```bash
docker compose up --build -d
```

For a fresh environment:

```bash
cp .env.example .env
docker compose up --build -d
```

Run the end-to-end smoke test:

```bash
./scripts/smoke.sh
```

The smoke creates a new organization/template/event on every run. It intentionally does not clean test data.

## Manual example

Create template:

```bash
curl -X POST http://localhost:8080/api/v1/event-templates \
  -H 'content-type: application/json' \
  -H 'x-organization-id: <ORG_ID>' \
  -d '{
    "name":"Casamento Padrão",
    "eventType":"wedding"
  }'
```

Add D-30 task:

```bash
curl -X POST http://localhost:8080/api/v1/event-templates/<TEMPLATE_ID>/tasks \
  -H 'content-type: application/json' \
  -H 'x-organization-id: <ORG_ID>' \
  -d '{
    "title":"Fechar RSVP",
    "offsetDays":-30,
    "dueTime":"09:00",
    "priority":"high",
    "type":"guest"
  }'
```

Create event from it:

```bash
curl -X POST http://localhost:8080/api/v1/events \
  -H 'content-type: application/json' \
  -H 'x-organization-id: <ORG_ID>' \
  -d '{
    "name":"Ana & Pedro",
    "type":"wedding",
    "templateId":"<TEMPLATE_ID>",
    "startAt":"2026-10-17T17:30:00-03:00",
    "guestCount":132
  }'
```

Read generated tasks:

```bash
curl http://localhost:8080/api/v1/events/<EVENT_ID>/tasks \
  -H 'x-organization-id: <ORG_ID>'
```

## Validation

Local static/core validation:

```bash
python3 scripts/validate_feature_02.py
```

Runtime validation on your Docker-enabled machine:

```bash
./scripts/smoke.sh
```

The packaging environment has Node/TypeScript/Python but not Docker or Bun, so it validates strict core behavior, project structure, migrations/contracts and shell syntax here; actual container startup is intentionally delegated to the included smoke test.

## Security boundary

`x-organization-id` is still only a development tenancy context. It must eventually be derived from authentication rather than trusted from an arbitrary header.

## Next slice

**Mini-feature 03 — Vendors + Event Vendors + confirmation state.**

That gives the system its first external operational actor and prepares the first genuinely useful n8n workflow: supplier confirmation/reminders.
