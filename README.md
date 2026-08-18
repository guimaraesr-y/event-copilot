# Event Command Center

Current version: **0.10.0 — Change Proposals**.

The Event Command Center is a vertical event-operations backend. PostgreSQL is the source of truth, domain engines own business transitions, the transactional outbox provides durable domain events, and n8n orchestrates external effects.

## Architecture

```text
External channels / API
        ↓
Operational Agent or deterministic endpoints
        ↓
server-owned tools
   ├── safe writes → CommandEngine
   └── sensitive writes → ChangeProposalEngine
                           ↓ approval
                      event mutation
        ↓
PostgreSQL + Transactional Outbox
        ↓
Worker
   ┌────┴────┐
   ↓         ↓
Operational  n8n
Projector    external effects
   ↓
Activity / Inbox
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
8. Text Command Engine (`rule_based | ai`)
8.1 AI provider abstraction + Ollama
8.2 Operational Agent with multi-event conversation and server-owned tools
8.3 OpenRouter Operational Agent provider
10. Change Proposals for sensitive event changes

Audio input remains in the backlog.

## Change Proposals

Sensitive event mutations are never applied directly by the model. The supported proposal types are:

```text
event_date
event_time
guest_count
venue
```

The conversational flow is:

```text
Planner: "Mude o horário para 17h"
        ↓
Operational Agent
        ↓
propose_event_time_change
        ↓
ChangeProposalEngine
        ↓
proposal + deterministic impacts
        ↓
"Deseja aprovar essa alteração?"

Planner: "sim"
        ↓
approve_change_proposal
        ↓
atomic transaction:
  proposal → applied
  event → updated
  outbox → change.applied + event.updated
```

Proposal creation never changes the event. Approval and event mutation are committed in the same PostgreSQL transaction.

Current impact analysis is deterministic. It warns about tasks/milestones, confirmed vendors, guest-dependent suppliers and venue logistics. It does **not** automatically reschedule tasks, milestones or vendor arrival times yet; that belongs to the future Dependency Engine.

See `docs/mini-feature-10.md`.

## Operational Agent providers

Ollama:

```env
OPERATIONAL_AGENT_PROVIDER=ollama
OLLAMA_AGENT_MODEL=
OLLAMA_AGENT_TOOL_MODE=prompt
```

OpenRouter:

```env
OPERATIONAL_AGENT_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_AGENT_MODEL=openrouter/auto
OPENROUTER_AGENT_TOOL_MODE=native
```

Talk to the Agent against an existing tenant:

```bash
bun scripts/operational-agent-chat.ts --organization <ORGANIZATION_UUID>
```

## Change Proposal API

```text
POST /api/v1/events/:eventId/change-proposals
GET  /api/v1/change-proposals
GET  /api/v1/change-proposals/:id
POST /api/v1/change-proposals/:id/approve
POST /api/v1/change-proposals/:id/reject
```

## Local development

```bash
cp .env.example .env
docker compose up --build -d
./scripts/n8n-sync.sh
bun packages/database/src/migrate.ts
```

## Full deterministic smoke

```bash
./scripts/smoke-env.sh
```

The smoke environment is isolated from the normal `.env` and forces mock/deterministic integrations. It now has **50 steps**, covering the complete flow through Change Proposal creation, impact persistence, Inbox projection, conversational approval, idempotency and rejection.

## Validation

```bash
python3 scripts/validate_foundation.py
python3 scripts/validate_feature_10.py
```

Docker runtime validation is performed locally through `./scripts/smoke-env.sh`.
