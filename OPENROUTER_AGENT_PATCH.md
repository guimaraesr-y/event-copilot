# OpenRouter Operational Agent — base integration

Este patch adiciona OpenRouter como provider do Operational Agent sem alterar as regras de domínio.

## Aplicação

Copie os arquivos sobre a Feature 08.2 + fix de `tool_trace` e rode:

```bash
bun packages/database/src/migrate.ts
```

Esperado:

```text
[migration] 013_operational_agent_openrouter: Success
```

## Configuração

```env
OPERATIONAL_AGENT_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_AGENT_MODEL=openrouter/auto
OPENROUTER_AGENT_TOOL_MODE=native
OPENROUTER_REQUIRE_PARAMETERS=true
OPENROUTER_DATA_COLLECTION=allow
```

Depois:

```bash
docker compose up -d --build api
bun scripts/operational-agent-chat.ts --organization <ORGANIZATION_UUID>
```

Para benchmark controlado, troque `openrouter/auto` por um slug fixo `provider/model`.

## Arquitetura

- `native`: usa tools/function calling do Chat Completions.
- `prompt`: usa protocolo `tool | final` com `response_format=json_schema`.
- `agent_turn.id` é enviado como `session_id` para manter sticky routing durante o loop do turno.
- `tool_call_id` é preservado entre a chamada do modelo e o resultado da tool.
- `OPENROUTER_REQUIRE_PARAMETERS=true` pede roteamento apenas para providers que suportem os parâmetros usados.
- smoke/CI continuam em `OPERATIONAL_AGENT_PROVIDER=deterministic`.

## Segurança

O provider não acessa banco ou repositories diretamente. Writes continuam passando por server-owned tools e `CommandEngine.executeStructured()`.
