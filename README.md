# 🎛️ Event Command Center

**Versão atual: 0.11.0 — Dependency Engine**

Backend vertical para operação de eventos e cerimoniais. O ECC concentra o estado real do evento no PostgreSQL, mantém as transições de negócio em engines determinísticas e usa IA como interface operacional — nunca como fonte de verdade.

> **Princípio central:** n8n executa processos; o backend decide o que é verdade.

## 🧭 Visão geral

O projeto já cobre planejamento, fornecedores, mensageria, inbound de fornecedores, Inbox operacional, comandos em linguagem natural, Operational Agent, Change Proposals e propagação controlada de dependências.

```text
Cerimonialista / API / WhatsApp
            ↓
      Operational Agent
            ↓
     server-owned tools
       ┌────┴─────────┐
       ↓              ↓
 CommandEngine   ChangeProposalEngine
                       ↓ aprovação
                  alteração sensível
                       ↓
                 change.applied
                       ↓
                DependencyEngine
             ┌─────────┴─────────┐
             ↓                   ↓
     sugestão calculável     revisão humana
             ↓                   ↓
       aprovação explícita    Inbox operacional
             ↓
 PostgreSQL + Transactional Outbox
             ↓
           Worker
       ┌─────┴─────┐
       ↓           ↓
  Projections      n8n
 Activity/Inbox  efeitos externos
```

## ✅ Features implementadas

| Feature | Entrega | Documentação |
|---|---|---|
| 01 | Foundation, Event e Transactional Outbox | [docs/mini-feature-01.md](docs/mini-feature-01.md) |
| 02 | Templates, Tasks e Milestones | [docs/mini-feature-02.md](docs/mini-feature-02.md) |
| 03 | Vendors e Event Vendors | [docs/mini-feature-03.md](docs/mini-feature-03.md) |
| 04 | Domain Event Gateway + n8n | [docs/mini-feature-04.md](docs/mini-feature-04.md) |
| 05 | Outbound Messaging | [docs/mini-feature-05.md](docs/mini-feature-05.md) |
| 05.1 | Generic Messaging Webhooks | [docs/mini-feature-05.1.md](docs/mini-feature-05.1.md) |
| 06 | Supplier Inbound + Resolution | [docs/mini-feature-06.md](docs/mini-feature-06.md) |
| 07 | Operational Inbox + Activity | [docs/mini-feature-07.md](docs/mini-feature-07.md) |
| 08 | Text Command Engine | [docs/mini-feature-08.md](docs/mini-feature-08.md) |
| 08.1 | AI Providers + Ollama | [docs/mini-feature-08.1.md](docs/mini-feature-08.1.md) |
| 08.2 | Operational Agent multi-evento | [docs/mini-feature-08.2.md](docs/mini-feature-08.2.md) |
| 08.3 | OpenRouter para o Operational Agent | [docs/openrouter-operational-agent.md](docs/openrouter-operational-agent.md) |
| 10 | Change Proposals | [docs/mini-feature-10.md](docs/mini-feature-10.md) |
| 11 | Dependency Engine | [docs/mini-feature-11.md](docs/mini-feature-11.md) |

Áudio/voice input permanece no backlog.

## 🔗 Dependency Engine

A Feature 11 transforma uma mudança aprovada em consequências operacionais persistidas. O engine separa o que é **deterministicamente recalculável** do que exige **revisão humana**.

Exemplo:

```text
Data do evento: 17/10 → 24/10
        ↓
Dependency Engine
        ├── tarefa de template D-7 → sugere +7 dias
        ├── milestone de template → sugere +7 dias
        ├── tarefa manual → review
        ├── agenda de fornecedor → sugere +7 dias
        └── fornecedor confirmado → reconfirmação obrigatória
```

Nenhuma dependência é aplicada silenciosamente. Sugestões ficam `open` até uma ação explícita; reviews precisam ser marcados como revisados ou descartados.

## 🤖 Operational Agent

O Agent pode trabalhar sobre vários eventos e usar providers diferentes sem acesso direto ao banco.

### Ollama

```env
OPERATIONAL_AGENT_PROVIDER=ollama
OLLAMA_AGENT_MODEL=
OLLAMA_AGENT_TOOL_MODE=prompt
```

### OpenRouter

```env
OPERATIONAL_AGENT_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_AGENT_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
OPENROUTER_AGENT_TOOL_MODE=native
```

CLI local:

```bash
bun scripts/operational-agent-chat.ts --organization <ORGANIZATION_UUID>
```

## 🚀 Desenvolvimento local

```bash
cp .env.example .env
docker compose up --build -d
bun packages/database/src/migrate.ts
./scripts/n8n-sync.sh
```

No Windows com Git Bash, `scripts/n8n-sync.sh` desabilita automaticamente a conversão MSYS de paths internos do container.

## 🧪 Validação

Validação estrutural/comportamental:

```bash
python3 scripts/validate_foundation.py
python3 scripts/validate_feature_11.py
```

Smoke isolado, sem IA paga:

```bash
./scripts/smoke-env.sh
```

O smoke usa:

```env
COMMAND_INTERPRETER=rule_based
OPERATIONAL_AGENT_PROVIDER=deterministic
MESSAGING_PROVIDER=mock
```

Assim, CI/smoke nunca consome créditos de Ollama/OpenRouter por acidente.

## 📁 Estrutura

```text
apps/
  api/                 HTTP API e composição das engines
  worker/              outbox, projections e avaliação de dependências
packages/
  domain/              contratos e regras de domínio
  database/            Kysely, repositories e migrations
  event-engine/        engines determinísticas e Operational Agent
  integrations/        providers externos
n8n/
  workflows/           orquestração de efeitos externos
docs/                   documentação de features e operação
scripts/                 setup, smoke, sync e validações
validation/              cenários comportamentais
```

## 🛡️ Regras de segurança arquitetural

- PostgreSQL é a source of truth.
- n8n não decide estado crítico de negócio.
- LLM não grava SQL nem acessa repositories diretamente.
- Writes do Agent usam tools controladas pelo servidor.
- Data, horário, convidados e local usam Change Proposals.
- Dependency Engine não propaga alterações sem autorização explícita.
- Sugestões são stale-aware: se o alvo mudou desde a avaliação, a aplicação é recusada.
- Tenant isolation continua por `organization_id`; `x-organization-id` ainda é contexto, **não autenticação real**.

## 🗺️ Roadmap

```text
11 Dependency Engine       ✅
12 Risk Engine             próxima
13 Health Score
14 Daily Command Brief
15 Briefing D-1
16 Event Day Mode
17 Dashboard

Backlog
- Voice / áudio
```

Para detalhes de cada slice, use o [índice de documentação](docs/README.md) em vez de adicionar documentação de feature na raiz do repositório.
