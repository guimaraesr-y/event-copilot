# Mini-feature 08.2 — Operational Agent

The Operational Agent moves the AI boundary from a rigid intent parser to a conversational, tool-using copilot while preserving deterministic domain writes.

## Why this exists

The AI Command Interpreter costs roughly one model inference even when the user only wants to ask a broad operational question. An agent can use that same inference budget to decide what data it needs, query the Event Command Center, compare multiple events and converse naturally.

The existing `CommandEngine` remains important: **the Agent never writes directly to PostgreSQL or repositories**.

```text
Planner message
      ↓
OperationalAgent
      ↓
AI provider (Ollama first)
      ↓
server-owned tool allowlist
  ├── read tools → Event/Vendor/Operational engines
  └── write tools → CommandEngine.executeStructured()
                         ↓
                     Domain Engine
                         ↓
                   PostgreSQL + Outbox
```

This avoids the expensive path:

```text
Agent inference → AI command-interpreter inference → write
```

A write selected by the Agent is already structured and therefore delegates directly to `CommandEngine.executeStructured()`. After a successful write, the Agent returns the deterministic domain reply immediately instead of spending a second model call just to paraphrase “task created”/“note added”. Read tools still require a second model call when conversational synthesis is needed.

## Conversation and multi-event reasoning

Every turn receives a compact catalog of up to 50 tenant events and the current event from `conversation_contexts`. The Agent can:

- summarize all active events;
- compare event workload at a high level;
- inspect one event in detail;
- inspect recent activity;
- inspect operational Inbox items;
- switch the current conversational event;
- maintain a short persisted conversation history.

`agent_turns` stores the user message, final response, provider/model, model-call count and tool trace. History is tenant + sender scoped.

## Tools

Read-only:

- `get_workspace_overview`
- `get_event_details`
- `get_event_activity`
- `get_inbox`

Safe writes:

- `select_event`
- `create_task`
- `complete_task`
- `add_event_note`

There is deliberately **no tool** for changing:

- event date;
- event time;
- guest count;
- venue/location/address.

Those remain reserved for the future Change Proposal layer. A model cannot bypass this because it receives no server-side capability that can perform the mutation.

## Ollama modes

The first real provider is Ollama.

```env
OPERATIONAL_AGENT_PROVIDER=ollama
OLLAMA_AGENT_MODEL=
OLLAMA_AGENT_TOOL_MODE=prompt
```

When `OLLAMA_AGENT_MODEL` is blank, the API reuses `OLLAMA_COMMAND_MODEL`.

### `prompt`

Uses `/api/chat` + strict JSON action schema to emulate one tool decision at a time. This is the compatibility mode for models that do not expose reliable native function calling.

### `native`

Passes Ollama `tools` directly to `/api/chat`. Use this only with a model whose Ollama integration supports tool calling well.

The server validates the tool name, event tenant ownership and every argument again before executing anything.

## Deterministic smoke

The normal smoke never invokes a model:

```env
COMMAND_INTERPRETER=rule_based
OPERATIONAL_AGENT_PROVIDER=deterministic
```

`smoke-env.sh` refuses to run if either deterministic setting is changed.

The full smoke now contains 43 steps and validates:

1. agent workspace overview;
2. tool trace persistence;
3. task creation through structured `CommandEngine` delegation;
4. domain task/outbox path;
5. turn idempotency;
6. persisted conversational history.

## Turn idempotency

`agent_turns` has a unique key on `(organization_id, idempotency_key)`.

A completed duplicate returns the cached final reply without a new model/tool call.

An existing `processing` or `failed` turn is **not automatically replayed** with the same key. This is conservative by design: a tool may have committed a side effect before an HTTP/model failure, and blindly replaying the agent loop could issue a second logical write. Inspect the turn and use a new idempotency key when retrying intentionally.

Individual write tools additionally use deterministic internal command keys:

```text
agent:<turnId>:<toolIndex>:<intent>
```

so the `CommandEngine` and domain persistence retain their existing idempotency guarantees.

## Local Ollama setup

```bash
./scripts/ollama-setup.sh
```

The script pulls both `OLLAMA_COMMAND_MODEL` and `OLLAMA_AGENT_MODEL` when they differ.

Start the application with the AI profile:

```bash
docker compose --profile ai up --build -d
```

For a local conversation against an existing tenant:

```bash
bun scripts/operational-agent-chat.ts \
  --organization <ORGANIZATION_UUID> \
  --sender planner-local
```

Inside the CLI:

```text
Como estão meus eventos?
Qual deles tem mais pendências?
E no casamento da Ana, quais fornecedores faltam?
Crie uma tarefa para confirmar o buffet amanhã às 10h.
```

The CLI also supports `/history`, `/event <uuid>`, `/event clear` and `/quit`.

## API

```http
POST /api/v1/agent/messages
x-organization-id: <uuid>
content-type: application/json
```

```json
{
  "sender": "planner-1",
  "text": "Como estão meus eventos?",
  "idempotencyKey": "wa-message-or-client-generated-id"
}
```

Optional `eventId` can explicitly select an event for that turn.

Conversation history:

```http
GET /api/v1/agent/history?sender=planner-1&limit=10
x-organization-id: <uuid>
```

## Not implemented yet

- automatic routing of planner WhatsApp inbound messages to the Agent;
- OpenAI/Gemini Operational Agent provider adapters;
- Change Proposal tools;
- voice transcription;
- long-term semantic memory/RAG.

The endpoint is channel-neutral, so WhatsApp/web/mobile can later reuse the same Agent without moving business rules into n8n.

## OpenRouter provider

O Operational Agent também suporta `OPERATIONAL_AGENT_PROVIDER=openrouter` via API Chat Completions compatível com OpenAI. Veja `docs/openrouter-operational-agent.md`.
