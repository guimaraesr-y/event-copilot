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


## AI providers: Ollama first, OpenAI optional

The Command Engine is provider-agnostic. `COMMAND_INTERPRETER=ai` delegates structured command extraction to the provider selected by `AI_PROVIDER`.

```env
COMMAND_INTERPRETER=ai
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_COMMAND_MODEL=qwen3:4b
OLLAMA_COMMAND_TIMEOUT_MS=120000
OLLAMA_KEEP_ALIVE=10m
```

Ollama is included in Compose under the optional `ai` profile so the normal deterministic smoke stack does not download or start an LLM:

```sh
./scripts/ollama-setup.sh
```

This starts `ollama/ollama`, waits for readiness and pulls the configured model. The default `qwen3:4b` is intentionally a relatively small starting point; change `OLLAMA_COMMAND_MODEL` to evaluate another local model.

To measure whether the self-hosted model is good enough for ECC command extraction:

```sh
./scripts/ollama-command-check.sh
```

The check runs five live interpretation scenarios and prints correctness plus latency per command and average latency. It does not mutate the ECC database.

To run the real API with the self-hosted interpreter:

```env
COMMAND_INTERPRETER=ai
AI_PROVIDER=ollama
```

then:

```sh
docker compose --profile ai up -d ollama
docker compose up -d --build api
```

OpenAI remains available by configuration:

```env
COMMAND_INTERPRETER=ai
AI_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_COMMAND_MODEL=gpt-5.6
```

The provider interface intentionally keeps Gemini as a future adapter without changing `CommandEngine` or its safety gates.
