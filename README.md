# Event Command Center

Current version: **0.8.2 — Operational Agent**.

The Event Command Center is a vertical event-operations backend. PostgreSQL is the source of truth, domain engines own business transitions, the transactional outbox provides durable domain events, and n8n orchestrates external effects.

## Architecture

```text
External channels / API
        ↓
Operational Agent or deterministic endpoints
        ↓
server-owned tools / CommandEngine
        ↓
Event · Vendor · Messaging · Inbound Engines
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
8.1 AI provider abstraction (`ollama | openai`) + local Ollama Compose profile
8.2 Operational Agent with multi-event conversation and server-owned tools

## Operational Agent

The AI is no longer restricted to translating every planner message into one intent. The Agent can inspect several events, query current operational state, use short persisted conversational history and call a small allowlist of tools.

```text
Planner
   ↓
OperationalAgent
   ↓
Ollama provider
   ↓
read tools ──────────────→ domain/query engines
write tools → CommandEngine.executeStructured()
                         ↓
                     domain engines
```

The model never gets database access. Sensitive event changes (date/time, guest count, venue/address) have no tool in this slice and cannot be applied directly.

See `docs/mini-feature-08.2.md`.

## AI configuration

Command Interpreter remains available for direct command endpoints:

```env
COMMAND_INTERPRETER=rule_based
# or ai
AI_PROVIDER=ollama
OLLAMA_COMMAND_MODEL=qwen3:4b
```

Operational Agent:

```env
OPERATIONAL_AGENT_PROVIDER=ollama
# blank = reuse OLLAMA_COMMAND_MODEL
OLLAMA_AGENT_MODEL=
# prompt | native
OLLAMA_AGENT_TOOL_MODE=prompt
```

Ollama is optional and lives behind the `ai` Compose profile:

```bash
./scripts/ollama-setup.sh
docker compose --profile ai up --build -d
```

To talk to the Agent against an existing tenant:

```bash
bun scripts/operational-agent-chat.ts --organization <ORGANIZATION_UUID>
```

## Local development

```bash
cp .env.example .env
docker compose up --build -d
./scripts/n8n-sync.sh
```

## Full deterministic smoke

```bash
./scripts/smoke-env.sh
```

The smoke environment is isolated from the normal `.env` and forces:

```text
WHATSAPP_PROVIDER=mock
COMMAND_INTERPRETER=rule_based
OPERATIONAL_AGENT_PROVIDER=deterministic
```

The full smoke currently has **43 steps**, covering foundation through Operational Agent delegation and turn idempotency without calling a real AI provider.

## Meta WhatsApp

For a real local Meta test use the normal `.env` with `WHATSAPP_PROVIDER=meta`. The public callback remains:

```text
GET/POST /api/v1/messaging/webhooks/meta
```

n8n never parses Meta-specific webhook payloads.

## Validation

```bash
python3 scripts/validate_foundation.py
python3 scripts/validate_feature_082.py
```

Docker runtime validation is performed locally through `./scripts/smoke-env.sh`.
