# Event Command Center — Mini-feature 01

Foundation + first vertical slice: **Organization → Event → transactional `event.created` outbox**.

This repository is intentionally not a “big n8n workflow”. PostgreSQL is the source of truth, the backend owns event invariants, and n8n is reserved for external orchestration. Mini-feature 01 proves that architectural boundary before we add templates, WhatsApp, Drive or Calendar.

## Delivered in this slice

- Bun monorepo (`apps/*`, `packages/*`)
- Hono API
- Kysely + PostgreSQL 18
- multi-tenant data foundation through `organization_id`
- `organizations`, `events`, and `outbox_events`
- `EventEngine` with deterministic business validation
- atomic event persistence + `event.created` outbox write
- outbox worker with retry/backoff and claim timeout
- n8n 2.34 container with its **own logical PostgreSQL database**
- Caddy gateway (`:8080`)
- liveness/readiness endpoints
- reproducible smoke-test script
- pure domain tests independent from framework/database

## Security boundary in this slice

`x-organization-id` is only a **development tenancy context**, not authentication or authorization. Every persisted business row is tenant-scoped from day one, but trusting this header is intentionally temporary. A later identity/security slice must derive `organization_id` from the authenticated principal (and can then add ABAC/RLS) instead of accepting an arbitrary tenant header.

## Why the worker uses `console` in this slice

The global n8n service is already part of the infrastructure, but **there is no production workflow yet**. The worker defaults to `OUTBOX_TRANSPORT=console`, consumes `event.created`, and marks it dispatched. This lets us validate the backend → outbox → worker boundary without creating a fake n8n workflow simply to make the foundation look complete.

The next orchestration slice can switch to:

```env
OUTBOX_TRANSPORT=n8n
N8N_DOMAIN_EVENTS_URL=http://n8n:5678/webhook/domain-events
```

without changing `EventEngine` or the API.

## Architecture

```text
Client
  │
  ▼
Caddy :8080
  │
  ├── /api/* ──► Hono API ──► EventEngine ──► PostgreSQL (ecc)
  │                                  │              │
  │                                  └── atomic ───► outbox_events
  │                                                 │
  │                                                 ▼
  │                                              Worker
  │                                                 │
  │                                      console now / n8n next
  │
  └── /* ──────► n8n ─────────────────────────► PostgreSQL (n8n)
```

## Running

```bash
cp .env.example .env
# Change POSTGRES_PASSWORD and N8N_ENCRYPTION_KEY if this leaves local development.
docker compose up --build -d
```

Then:

- API readiness: `http://localhost:8080/api/health/ready`
- n8n: `http://localhost:8080/`

Run the end-to-end smoke test:

```bash
./scripts/smoke.sh
```

Expected final line:

```text
Smoke test passed.
```

## Manual API example

Create an organization:

```bash
curl -X POST http://localhost:8080/api/v1/organizations \
  -H 'content-type: application/json' \
  -d '{"name":"Meu Cerimonial","timezone":"America/Sao_Paulo"}'
```

Create an event using the returned organization id:

```bash
curl -X POST http://localhost:8080/api/v1/events \
  -H 'content-type: application/json' \
  -H 'x-organization-id: <ORG_ID>' \
  -d '{
    "name":"Ana & Pedro",
    "type":"wedding",
    "startAt":"2026-10-17T17:30:00-03:00",
    "guestCount":132,
    "venueName":"Casa do Lago"
  }'
```

This transaction writes both:

1. `events`
2. `outbox_events` with `event_type = event.created`

If either insert fails, neither is committed.

## Validation performed before packaging

`python3 scripts/validate_foundation.py` checks:

1. expected Bun/workspace contract;
2. valid Compose YAML with all five global services;
3. health-gated service startup;
4. tenant and event constraints in the migration;
5. atomic Event + Outbox persistence boundary;
6. isolated `ecc` and `n8n` logical databases;
7. full-project TypeScript structural compilation;
8. shell entrypoint parsing;
9. strict compilation of the pure domain/EventEngine;
10. executable behavioral tests for EventEngine.

The build environment used to produce this ZIP does **not** provide Docker or Bun, so a real `docker compose up` cannot be executed here. The repository therefore also includes `scripts/smoke.sh`, which performs the complete runtime smoke test on a Docker-enabled machine.

## Deliberately not included yet

- event templates
- tasks/milestones
- vendor management
- WhatsApp
- Google Drive / Calendar
- Change Proposal
- Risk/Health engines beyond initial score
- web dashboard

They will be added as vertical mini-features while preserving the contracts established here.

## Next recommended slice

**Mini-feature 02 — Event Templates + automatic task/milestone instantiation**.

That is the next feature because it makes a newly created event immediately operational and establishes the task model that later powers Daily Brief, Health Score, Risk Engine and Event Day Mode.
