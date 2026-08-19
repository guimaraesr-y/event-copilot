# Mini-feature 12 — Risk Engine

A Feature 12 adiciona uma camada determinística de interpretação operacional sobre o estado dos eventos. O backend transforma tarefas, fornecedores, Inbox, dependências e mudanças recentes em riscos persistidos, priorizados e automaticamente reconciliados.

## Objetivo

Antes desta feature, o ECC sabia **o que estava pendente**. Agora ele também consegue responder **o que merece atenção primeiro e por quê**.

```text
Tasks ───────────────┐
Vendors ─────────────┤
Inbox ───────────────┤
Dependencies ────────┼──→ RiskEngine
Change Proposals ────┘         ↓
                         risk_evaluations
                         event_risks
                              ↓
                  API / Operational Agent / Inbox
```

A IA não calcula risco. O modelo apenas consulta e explica os resultados produzidos pelo backend.

## Tipos de risco

```text
task_overdue
task_due_soon
vendor_unconfirmed
vendor_declined
vendor_schedule_review
dependency_unresolved
critical_inbox_item
recent_sensitive_change
change_dependency_pending
```

Cada risco possui:

- `risk_key` estável por regra/entidade;
- score de `0` a `100`;
- severidade `low | medium | high | critical`;
- fonte (`task`, `event_vendor`, `dependency_impact`, etc.);
- descrição e metadata auditável;
- timestamps de primeira e última detecção;
- estado `open | acknowledged | resolved`.

## Score e severidade

O score é calculado por regras discretas e auditáveis. A distância temporal do evento altera a urgência, mas não substitui o impacto operacional.

Mapeamento atual:

```text
0–24    low
25–49   medium
50–74   high
75–100  critical
```

Exemplos:

- fornecedor não confirmado a mais de 90 dias → baixo;
- mesmo fornecedor a 7 dias → alto;
- fornecedor recusado a poucos dias → crítico;
- tarefa crítica atrasada → recebe boost de prioridade + atraso + proximidade do evento;
- dependência `critical` aberta → risco alto/crítico conforme urgência.

## Regras atuais

### Tarefas

Tarefas `pending` ou `in_progress` com prazo no passado geram `task_overdue`.

Tarefas que vencem nas próximas 48h geram `task_due_soon`, desde que ainda não estejam atrasadas.

Prioridade `high`/`critical` aumenta o score.

### Fornecedores

`pending` e `requested` geram `vendor_unconfirmed`. A severidade cresce conforme o evento se aproxima e recebe penalidade adicional se `confirmation_deadline_at` venceu.

`declined` gera `vendor_declined`, normalmente alto/crítico.

### Dependency Engine

Dependências abertas relacionadas a agenda/logística de fornecedor geram `vendor_schedule_review`.

Outras dependências abertas geram `dependency_unresolved`.

Quando uma mesma Change Proposal deixa duas ou mais dependências abertas, também existe um risco agregado `change_dependency_pending`, útil para priorização de mudanças com efeito cascata.

### Operational Inbox

Itens críticos do Inbox podem gerar `critical_inbox_item`. Itens originados pelo próprio Risk Engine ou por dependências/fornecedores são filtrados para evitar duplicação circular.

### Mudanças sensíveis recentes

Uma Change Proposal aplicada nas últimas 72h pode gerar `recent_sensitive_change` quando o evento está a até 30 dias. A severidade aumenta perto do evento.

## Identidade estável e reconciliação

O Risk Engine não cria uma linha nova toda vez que roda.

```text
vendor_unconfirmed:<event_vendor_id>
```

é uma identidade estável. O mesmo risco pode evoluir:

```text
medium → high → critical → resolved
```

`risk_evaluations` registra cada avaliação. `event_risks` mantém o estado reconciliado do risco.

A avaliação é idempotente por:

```text
organization_id + event_id + trigger_key
```

O repository usa advisory lock por evento para evitar reconciliações concorrentes inconsistentes.

## Resolução automática

Risco não é encerrado manualmente para “fingir” que a causa sumiu.

Exemplo:

```text
Buffet solicitado, sem confirmação
      ↓
vendor_unconfirmed = high
      ↓
Buffet confirma
      ↓
novo Domain Event
      ↓
RiskEngine reavalia
      ↓
risk.resolved
```

`acknowledged` significa apenas que o operador viu/reconheceu o risco. A causa continua ativa e o risco continua entrando nas consultas de riscos ativos.

## Domain Events

```text
risk.detected
risk.updated
risk.acknowledged
risk.resolved
risk.evaluation_completed
```

`risk.detected`/`risk.updated` abrem Operational Inbox apenas quando a severidade chega a `high` ou `critical`. Isso reduz alert fatigue.

`risk.resolved` resolve o Inbox associado ao risco.

## Triggers

### Event-driven

O worker reavalia imediatamente eventos afetados por Domain Events relevantes, por exemplo:

```text
task.created
task.updated
task.completed
vendor.confirmation_requested
vendor.confirmed
vendor.declined
change.applied
dependency.applied
dependency.resolved
```

O trigger key é `domain:<outbox_event_id>`, portanto retries do worker são idempotentes.

### Temporal sweep

Riscos também mudam apenas pela passagem do tempo. Por isso o worker executa um sweep periódico:

```env
RISK_SWEEP_INTERVAL_MS=300000
```

O sweep usa buckets temporais idempotentes. O valor `0` desabilita o sweep — usado no smoke para eliminar timing não determinístico.

## API

```text
GET  /api/v1/risks
GET  /api/v1/risks/workspace
GET  /api/v1/risks/:id
POST /api/v1/events/:eventId/risks/evaluate
POST /api/v1/risks/:id/acknowledge
```

Filtros de `GET /risks`:

```text
eventId
status
severity
type
minScore
limit
```

`GET /risks/workspace` agrupa os riscos ativos por evento e ordena eventos pelo maior score operacional.

## Operational Agent

Tools adicionadas:

```text
get_event_risks
get_workspace_risks
evaluate_event_risks
acknowledge_risk
```

Exemplos:

```text
Planner: "O que está preocupante no casamento da Ana?"
Agent:   get_event_risks → explica riscos reais e scores do backend.

Planner: "Qual evento precisa mais de atenção?"
Agent:   get_workspace_risks → compara eventos por risco atual.

Planner: "Reavalie os riscos da Ana."
Agent:   evaluate_event_risks
```

`evaluate_event_risks` e `acknowledge_risk` possuem guard independente do prompt: o texto atual precisa pedir explicitamente a reavaliação/reconhecimento.

## Migration

```text
016_risk_engine
```

Tabelas:

```text
risk_evaluations
event_risks
```

## Smoke

O smoke passa a ter 62 etapas e cobre:

1. criação de tarefa crítica já atrasada;
2. detecção event-driven de `task_overdue`;
3. consulta pela API;
4. projeção de risco alto no Inbox;
5. consulta pelo Operational Agent;
6. `acknowledged` sem resolver a causa;
7. conclusão da tarefa;
8. resolução automática do risco + Inbox.

O sweep periódico fica desabilitado no smoke (`RISK_SWEEP_INTERVAL_MS=0`), portanto a cobertura é determinística.

## Limite desta feature

O Risk Engine **não modifica `events.health_score`**. A transformação do conjunto de riscos em uma nota de saúde operacional pertence à Feature 13 — Health Score.
