# Feature 08.2 — Operational Agent

Apply this project over Feature 08.1 + the migration/encoding/Ollama host-check fixes.

Highlights:

- Adds a conversational `OperationalAgent` that can reason across several tenant events.
- Adds server-owned read tools for workspace overview, event details, activity and Inbox.
- Adds safe write tools for event selection, task creation/completion and event notes.
- Agent writes delegate to `CommandEngine.executeStructured()` — no second AI interpretation, no direct repository/SQL access, and no second model call just to paraphrase a successful write.
- Adds `agent_turns` migration with tenant-scoped idempotency, provider/model metadata, model-call count and tool trace.
- Adds short persisted conversation history per `(organization, sender)`.
- Supports Ollama `prompt` tool mode for models without native tool calling and `native` mode for models that support tools.
- Adds a deterministic Operational Agent provider exclusively for smoke/CI.
- Full smoke expands to 43 steps without invoking Ollama.
- Adds `scripts/operational-agent-chat.ts` for interactive local testing.
- `ollama-setup.sh` now pulls command and agent models separately when configured differently.
- Fixes Compose so blank `OLLAMA_AGENT_MODEL` really inherits `OLLAMA_COMMAND_MODEL` inside the API factory.

Real local setup:

```env
OPERATIONAL_AGENT_PROVIDER=ollama
OLLAMA_AGENT_MODEL=phi3:mini
OLLAMA_AGENT_TOOL_MODE=prompt
```

Then:

```sh
./scripts/ollama-setup.sh
docker compose --profile ai up --build -d
bun scripts/operational-agent-chat.ts --organization <ORGANIZATION_UUID>
```
