# Event Command Center

Current version: **0.8.0 — Text Command Engine (Rule-based + AI)**.

The Event Command Center is being built as a vertical event-operations backend. PostgreSQL is the source of truth, domain engines own business transitions, the transactional outbox provides durable domain events, and n8n orchestrates external effects.

## Current flow

```text
Event / Vendor / Messaging / Inbound / Command Engines
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
8. Text Command Engine (`rule_based | ai`)

## Feature 08

The planner can now issue safe text commands through:

```text
POST /api/v1/commands
```

Supported commands include event status, open tasks, pending vendors, task creation/completion, event notes and conversation-context selection. Sensitive event changes are recognized but **not applied**; they return `requiresChangeProposal=true` for the future Change Proposal feature.

Two interpreters implement the same contract:

```text
RuleBasedCommandInterpreter  → deterministic smoke/tests
AICommandInterpreter         → OpenAI Responses API + strict Structured Outputs
```

Set the real environment to AI with:

```env
COMMAND_INTERPRETER=ai
OPENAI_API_KEY=...
OPENAI_COMMAND_MODEL=gpt-5.6
```

The deterministic smoke always uses `COMMAND_INTERPRETER=rule_based` and contains no OpenAI credential. See `docs/mini-feature-08.md`.

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
COMMAND_INTERPRETER=rule_based
```

By default the dedicated smoke volumes are reset before every run. To preserve them for debugging:

```bash
SMOKE_RESET=0 ./scripts/smoke-env.sh
```

The full smoke currently covers foundation through Feature 08, including supplier confirmation, outbound/inbound messaging, activity/inbox projection, conversation context, rule-based command execution, command idempotency and sensitive-change gating.

## Meta WhatsApp

For a real local Meta test use the normal `.env` with `WHATSAPP_PROVIDER=meta`. The public callback remains:

```text
GET/POST /api/v1/messaging/webhooks/meta
```

n8n never parses Meta-specific webhook payloads.

## Validation

```bash
python3 scripts/validate_foundation.py
python3 scripts/validate_feature_08.py
```

Docker runtime validation is performed locally through `./scripts/smoke-env.sh` because Docker is not available in the artifact-generation environment.
