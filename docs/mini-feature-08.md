# Mini-feature 08 — Text Command Engine

## Goal

Allow an event planner to issue safe operational commands in natural language while keeping domain mutation deterministic, validated and auditable.

The command boundary is currently the authenticated/tenant-scoped API (`POST /api/v1/commands`). Messaging-to-planner identity mapping is intentionally deferred; supplier inbound continues to use the messaging webhook flow from Feature 06.

## Interpreters

Both implementations conform to `CommandInterpreter`:

- `RuleBasedCommandInterpreter`: deterministic parser used by the full smoke and local tests.
- `AICommandInterpreter`: provider-agnostic interpreter. `AI_PROVIDER=ollama|openai` selects the adapter; both only return a `CommandInterpretation` and never access repositories or execute a mutation.

Configuration:

```env
COMMAND_INTERPRETER=rule_based # or ai
AI_PROVIDER=ollama # or openai
OLLAMA_COMMAND_MODEL=qwen3:4b
OPENAI_API_KEY=
OPENAI_COMMAND_MODEL=gpt-5.6
```

The smoke environment always pins `COMMAND_INTERPRETER=rule_based` and refuses to run otherwise.

## Supported intents

Safe/query intents:

- `GET_EVENT_STATUS`
- `GET_OPEN_TASKS`
- `GET_PENDING_VENDORS`
- `CREATE_TASK`
- `COMPLETE_TASK`
- `ADD_EVENT_NOTE`
- `SET_CURRENT_EVENT`

Guarded intents:

- `SENSITIVE_CHANGE`: detected but rejected with `requiresChangeProposal=true`; Feature 10 will turn this into a proper change proposal.
- `UNKNOWN`: retained for human review instead of guessing.

## Safety boundary

```text
text
 ↓
CommandInterpreter
 ↓
CommandInterpretation
 ↓
local validation + event/task resolution
 ↓
CommandEngine
 ↓
EventEngine / VendorEngine / CommandStore
```

The AI interpreter cannot emit SQL, call repositories, or directly mutate domain entities.

Event resolution follows this priority:

1. explicit `eventId` supplied by the API caller;
2. unique event-name/reference match;
3. saved `conversation_contexts.current_event_id`;
4. the only active event, if exactly one exists.

Ambiguous event/task matches become `needs_review`.

## Idempotency

`command_requests` has `UNIQUE (organization_id, idempotency_key)`.

The same key + same payload returns the already processed result with `duplicate=true`. The same key with a different payload is rejected.

Command-created tasks additionally persist `event_tasks.source_command_request_id` with a unique constraint. Event notes use `event_notes.source_command_request_id` with a unique constraint. This protects the side effect if the command request is retried after a partial failure.

## Conversation context

`conversation_contexts` stores one current event per `(organization_id, sender)`.

Example:

```text
"Selecione o evento Ana & Pedro"
        ↓
current_event_id = Ana & Pedro

"Crie uma tarefa para confirmar o buffet amanhã às 10h"
        ↓
uses current_event_id without repeating the event name
```

## Operational projection

`task.created`, `task.completed` and `event.note_added` become Activity Log entries through the existing internal `OperationalProjector` before external n8n dispatch.

## API

```text
POST /api/v1/commands
GET  /api/v1/commands/:requestId
GET  /api/v1/command-context?sender=...
```

Example:

```json
{
  "sender": "planner:ryan",
  "text": "Crie uma tarefa para confirmar o buffet amanhã às 10h",
  "idempotencyKey": "ui-message-123"
}
```

## AI path

`AICommandInterpreter` delegates to an `AICommandProvider`. Ollama uses `/api/chat` with JSON-schema structured output; OpenAI uses the Responses API with strict JSON Schema output. The returned structure is validated locally again before the `CommandEngine` consumes it.

The AI path is not required for the deterministic smoke test. `.env.smoke` pins `COMMAND_INTERPRETER=rule_based`.
