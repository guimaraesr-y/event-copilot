# 🎛️ Event Command Center

**Versão atual: 0.15.0 — Briefing D-1**

Backend vertical para operação de eventos e cerimoniais. O ECC concentra o estado real do evento no PostgreSQL, mantém as decisões de negócio em engines determinísticas e usa IA como interface operacional — nunca como fonte de verdade.

> **Princípio central:** n8n executa processos; o backend decide o que é verdade.

## 🧭 Visão geral

O projeto cobre planejamento, fornecedores, mensageria, inbound, Inbox/Activity, comandos em linguagem natural, Operational Agent multi-evento, Change Proposals, propagação controlada de dependências, priorização operacional por risco, Health Score explicável, Daily Command Brief e Briefing D-1 agendáveis por organização.

```text
Cerimonialista / API / WhatsApp
            ↓
      Operational Agent
            ↓ server-owned tools
    ┌───────┼────────────┐
    ↓       ↓            ↓
Command  Change       consultas
Engine   Proposal       reais
            ↓
       change.applied
            ↓
     DependencyEngine
            ↓
   dependency_impacts ───────┐
                             │
Tasks / Vendors / Inbox ─────┼──→ RiskEngine
Change Proposals ────────────┘        ↓
                                 event_risks
                                      ↓
                                 HealthEngine
                                      ↓
                      events.health_score + histórico
                                      ↓
                                  BriefEngine
                           ┌──────────┴──────────┐
                           ↓                     ↓
                    Agent / API         scheduler por tenant
                                                 ↓
                                      brief.delivery_requested
                                                 ↓
                                               n8n
                                                 ↓
                                      WhatsApp / efeitos externos
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
| 12 | Risk Engine | [docs/mini-feature-12.md](docs/mini-feature-12.md) |
| 13 | Health Score | [docs/mini-feature-13.md](docs/mini-feature-13.md) |
| 14 | Daily Command Brief + agendamento | [docs/mini-feature-14.md](docs/mini-feature-14.md) |
| 15 | Briefing D-1 + readiness + agenda por evento | [docs/mini-feature-15.md](docs/mini-feature-15.md) |

Áudio/voice input permanece no backlog.

## ☀️ Daily Command Brief

A Feature 14 consolida o estado operacional da organização em um brief diário persistido e explicável. O conteúdo é calculado pelo backend; o LLM apenas consulta, explica ou altera a preferência quando solicitado.

```text
Health / Risks / Tasks / Vendors / Dependencies
                    ↓
                BriefEngine
                    ↓
             daily_briefs
                    ↓
        brief.delivery_requested
                    ↓
                   n8n
                    ↓
            WhatsApp do operador
```

O envio é opt-in por organização. Horário e destinatário podem ser configurados pela API ou pelo próprio Operational Agent, sempre no timezone da organização:

```text
"Me manda o brief todo dia às 07:30 neste WhatsApp."
```

O worker verifica preferências periodicamente; a chave `scheduled:YYYY-MM-DD` garante no máximo um envio agendado por organização/dia, inclusive após restart. Gerações manuais criam revisões sem apagar o histórico.

Configuração do scheduler:

```env
BRIEF_SCHEDULER_INTERVAL_MS=60000
```

Detalhes: [docs/mini-feature-14.md](docs/mini-feature-14.md).

## 💚 Health Score

A Feature 13 transforma riscos ativos em uma leitura operacional única de `0–100`, mantendo o cálculo totalmente determinístico.

```text
Risk Engine
    ↓
riscos ativos
    ↓
Health Engine
    ├── penalidade por categoria
    ├── severity ceiling
    └── breakdown explicável
    ↓
events.health_score
```

Faixas atuais:

```text
90–100  excellent
75–89   good
55–74   attention
0–54    critical
```

Health Score **não é percentual de planejamento concluído**. Riscos reconhecidos continuam penalizando até que a causa seja resolvida. Cada avaliação registra histórico, delta e os principais fatores responsáveis pela nota.

Detalhes da fórmula: [docs/mini-feature-13.md](docs/mini-feature-13.md).

## ⚠️ Risk Engine

A Feature 12 transforma estado operacional em riscos determinísticos e priorizados.

```text
"Buffet não confirmou"
       ↓
120 dias antes → low
30 dias antes  → medium
7 dias antes   → high
1 dia antes    → critical
```

O risco possui identidade estável. Ele pode escalar, ser reconhecido pelo operador e ser **resolvido automaticamente** quando a causa desaparece.

`low` e `medium` ficam disponíveis para API/Agent; apenas `high` e `critical` abrem Operational Inbox automaticamente.

O worker também executa reavaliação temporal:

```env
RISK_SWEEP_INTERVAL_MS=300000
```

Detalhes das regras e scores: [docs/mini-feature-12.md](docs/mini-feature-12.md).

## 🔗 Dependency Engine

Mudanças sensíveis aprovadas geram consequências persistidas. O engine separa sugestões deterministicamente recalculáveis de revisões humanas e nunca propaga uma alteração silenciosamente.

```text
Data: 17/10 → 24/10
    ├── task de template → sugestão +7 dias
    ├── milestone → sugestão +7 dias
    ├── agenda de fornecedor → sugestão +7 dias
    └── itens não determinísticos → review
```

Sugestões são stale-aware: se o alvo mudou depois da avaliação, a aplicação é recusada.

## 🤖 Operational Agent

O Agent trabalha sobre vários eventos usando tools controladas pelo servidor. Ele pode consultar riscos, Health Score e Daily Brief, além de configurar o horário/destinatário do brief sem calcular ou inventar prioridades.

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

## 🌙 Briefing D-1

A Feature 15 reutiliza o Brief Engine para responder **“estamos prontos para amanhã?”** por evento. O backend gera um checklist determinístico com `READY`, `READY_WITH_WARNINGS` ou `NOT_READY`, cronograma de fornecedores, riscos, tarefas, milestones, dependências, mudanças e Inbox.

O schedule D-1 é independente do Daily Brief e pode ser configurado pelo Operational Agent. Na véspera, o worker gera uma única revisão agendada por evento e publica `brief.delivery_requested`; n8n e Messaging Engine reutilizam o mesmo pipeline de WhatsApp com `message_type=d_minus_1_brief`.

Detalhes: [docs/mini-feature-15.md](docs/mini-feature-15.md).

## 🚀 Desenvolvimento local

```bash
cp .env.example .env
docker compose up --build -d
bun packages/database/src/migrate.ts
```

O Compose possui um serviço one-shot `n8n-init`: em uma instância nova ou vazia ele importa e publica o `ECC Domain Event Gateway` antes de iniciar o runtime do n8n. O container `n8n-init` terminar em `Exited (0)` é o comportamento esperado.

Ao editar `n8n/workflows/ecc-domain-event-gateway.json` com o stack já em execução, faça o redeploy explícito sem recriar volumes:

```bash
./scripts/n8n-sync.sh
```

No Windows com Git Bash, `scripts/n8n-sync.sh` desabilita automaticamente a conversão MSYS de paths internos do container.

## 🧪 Validação

```bash
python3 scripts/validate_foundation.py
python3 scripts/validate_feature_14.py
```

Smoke isolado e sem IA paga:

```bash
./scripts/smoke-env.sh
```

O smoke usa:

```env
COMMAND_INTERPRETER=rule_based
OPERATIONAL_AGENT_PROVIDER=deterministic
MESSAGING_PROVIDER=mock
RISK_SWEEP_INTERVAL_MS=0
BRIEF_SCHEDULER_INTERVAL_MS=500
```

O sweep de risco fica desligado apenas no smoke; o scheduler de brief roda em intervalo curto para validar configuração pelo Agent e entrega via n8n/mock sem depender do relógio de produção.

## 📁 Estrutura

```text
apps/
  api/                 HTTP API e composição das engines
  worker/              outbox, projections, Dependency/Risk/Health e Brief scheduler
packages/
  domain/              contratos e regras de domínio
  database/            Kysely, repositories e migrations
  event-engine/        engines determinísticas e Operational Agent
  messaging/           providers/adapters de mensageria
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
- Risk Engine é determinístico; IA apenas consulta/explica riscos.
- Health Score é calculado pelo backend a partir dos riscos ativos; IA não escolhe nota nem tendência.
- Daily Brief e ranking de prioridades são determinísticos; o Agent só consulta/configura.
- O agendamento do brief é server-owned e idempotente por organização/data.
- `acknowledged` não resolve a causa de um risco.
- Tenant isolation continua por `organization_id`; `x-organization-id` ainda é contexto, **não autenticação real**.

## 🗺️ Roadmap

```text
11 Dependency Engine       ✅
12 Risk Engine             ✅
13 Health Score            ✅
14 Daily Command Brief     ✅
15 Briefing D-1            ✅
16 Event Day Mode           próxima
17 Dashboard

Backlog
- Voice / áudio
```

Para detalhes de cada slice, use o [índice de documentação](docs/README.md). Documentação de feature permanece em `docs/`, não na raiz.
