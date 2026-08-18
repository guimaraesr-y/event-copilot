# Operational Agent com OpenRouter

O Operational Agent pode usar OpenRouter sem alterar o `CommandEngine`, as tools ou as regras de domínio.

## Arquitetura

```text
OperationalAgent
      ↓
OperationalAgentProvider
  ├── OllamaOperationalAgentProvider
  ├── OpenRouterOperationalAgentProvider
  └── DeterministicOperationalAgentProvider (smoke/CI)
```

O OpenRouter usa a API `POST /api/v1/chat/completions`, sem SDK adicional.

## Configuração mínima

No `.env`:

```env
OPERATIONAL_AGENT_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_AGENT_MODEL=openrouter/auto
OPENROUTER_AGENT_TOOL_MODE=native
```

Depois reconstrua a API:

```bash
docker compose up -d --build api
```

E teste com o mesmo CLI do Agent:

```bash
bun scripts/operational-agent-chat.ts --organization <ORGANIZATION_UUID>
```

## Escolha de modelo

`openrouter/auto` é útil para exploração inicial. Para benchmark de custo, qualidade e latência, prefira fixar um slug:

```env
OPENROUTER_AGENT_MODEL=<provider>/<model>
```

Assim cada rodada usa a mesma família de modelo.

## Tool modes

### `native`

```env
OPENROUTER_AGENT_TOOL_MODE=native
```

Usa `tools`/function calling nativos do endpoint Chat Completions. O provider preserva `tool_call_id` entre a resposta do modelo e o resultado executado pelo ECC.

Este é o modo padrão.

### `prompt`

```env
OPENROUTER_AGENT_TOOL_MODE=prompt
```

Usa o mesmo protocolo de ação `tool | final` do Ollama em modo prompt, mas solicita Structured Output via `response_format=json_schema`.

Use apenas com modelos que suportem structured outputs.

## Provider routing

Por padrão:

```env
OPENROUTER_REQUIRE_PARAMETERS=true
```

Isso pede ao OpenRouter para escolher apenas um backend que suporte os parâmetros usados pelo ECC, como tools ou structured output.

Privacidade de roteamento:

```env
OPENROUTER_DATA_COLLECTION=allow
```

Valores aceitos:

- `allow`
- `deny`

Para produção com dados reais de eventos, avalie `deny`, validando antes a disponibilidade do modelo/provider escolhido.

## App attribution opcional

```env
OPENROUTER_HTTP_REFERER=https://seu-dominio.example
OPENROUTER_APP_TITLE=Event Command Center
```

Esses headers são opcionais.

## Base URL

Default:

```env
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

## Timeout

```env
OPENROUTER_AGENT_TIMEOUT_MS=60000
```

## Segurança do domínio

OpenRouter não ganha acesso ao banco.

O fluxo continua:

```text
modelo
  ↓
server-owned tool call
  ↓
validação de argumentos + tenant
  ↓
CommandEngine.executeStructured()
  ↓
Domain Engine
```

Data, horário do evento, quantidade de convidados e local continuam sem tool de escrita no Operational Agent.

## Smoke

O smoke principal não chama OpenRouter:

```env
OPERATIONAL_AGENT_PROVIDER=deterministic
```

Assim CI/smoke continuam sem custo e sem dependência de rede externa.
