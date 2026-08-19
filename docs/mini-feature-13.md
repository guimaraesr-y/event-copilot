# Feature 13 — Health Score

A Feature 13 transforma os riscos ativos do Event Command Center em uma leitura única e explicável de **saúde operacional de 0 a 100**.

> Health Score não é percentual de planejamento concluído. Um evento distante pode estar em `100/100` com muitas tarefas futuras se nenhuma delas representar risco operacional no momento.

## Objetivos

- manter `events.health_score` como estado atual consultável rapidamente;
- calcular score somente a partir de fatos do backend;
- registrar histórico e tendência;
- explicar exatamente quais riscos reduziram o score;
- recalcular automaticamente depois de cada `risk.evaluation_completed`;
- permitir consulta e reavaliação via API e Operational Agent.

## Fluxo

```text
Tasks / Vendors / Inbox / Dependencies
                ↓
            Risk Engine
                ↓
       risk.evaluation_completed
                ↓
           Health Engine
          ┌─────┴─────┐
          ↓           ↓
 events.health_score  event_health_evaluations
          ↓           ↓
        API / Operational Agent
```

O worker processa `risk.evaluation_completed` somente depois que o Risk Engine reconciliou os riscos do evento. Dessa forma o Health Engine sempre calcula em cima do snapshot persistido mais recente.

## Faixas

| Score | Status |
|---|---|
| 90–100 | `excellent` |
| 75–89 | `good` |
| 55–74 | `attention` |
| 0–54 | `critical` |

## Penalidade por risco

Cada risco ativo (`open` ou `acknowledged`) gera uma contribuição simples e auditável:

```text
penalty = ceil(risk.score / 5)
```

Risco reconhecido continua penalizando, porque `acknowledged` significa apenas que o operador viu o problema — a causa ainda existe.

As contribuições são agrupadas para evitar que dezenas de sinais correlacionados de um único domínio destruam o score de forma desproporcional:

| Categoria | Tipos | Cap |
|---|---|---:|
| task | `task_overdue`, `task_due_soon` | 30 |
| vendor | riscos de fornecedor/agendamento | 35 |
| dependency | dependências e cascatas pendentes | 25 |
| inbox | `critical_inbox_item` | 20 |
| change | mudança sensível recente | 15 |

```text
score bruto = 100 - soma dos caps por categoria
```

## Severity ceiling

O score não pode esconder um risco de severidade alta apenas porque há poucos itens:

```text
1+ high       → score máximo 84
1 critical    → score máximo 69
2+ critical   → score máximo 49
```

O valor final é:

```text
healthScore = max(0, min(scoreBruto, severityCeiling))
```

## Breakdown

Cada avaliação registra:

```json
{
  "baseScore": 100,
  "totalPenalty": 26,
  "severityCeiling": 84,
  "activeRiskCount": 3,
  "acknowledgedRiskCount": 1,
  "criticalCount": 0,
  "highCount": 1,
  "mediumCount": 2,
  "lowCount": 0,
  "categoryPenalties": {
    "task": 15,
    "vendor": 0,
    "dependency": 11,
    "inbox": 0,
    "change": 0
  },
  "topFactors": []
}
```

`topFactors` traz até cinco riscos responsáveis pelas maiores penalidades para permitir explicação pelo Agent/Dashboard.

## Persistência

Migration `017_health_score` cria:

```text
event_health_evaluations
```

O valor atual continua em:

```text
events.health_score
```

A atualização do evento, histórico e Domain Event `health.updated` acontece na mesma transação.

A chave `(organization_id, event_id, trigger_key)` garante idempotência de uma mesma avaliação.

## Domain Event

Quando o score muda:

```text
health.updated
```

O evento contém score anterior, novo score, delta, status e principais fatores. Ele entra no Activity Log, mas não abre Inbox por conta própria — os riscos responsáveis já têm seu próprio mecanismo de Inbox.

## API

### Workspace

```http
GET /api/v1/health-scores/workspace
```

Ordena eventos ativos do menos saudável para o mais saudável.

### Estado atual

```http
GET /api/v1/events/:eventId/health-score
```

### Histórico

```http
GET /api/v1/events/:eventId/health-score/history
```

### Reavaliação manual

```http
POST /api/v1/events/:eventId/health-score/evaluate
```

Exemplo:

```json
{
  "idempotencyKey": "manual-health-2026-08-19"
}
```

## Operational Agent

Tools adicionadas:

```text
get_event_health
get_workspace_health
evaluate_event_health
```

O Agent não calcula nem modifica o score. Ele apenas consulta a engine e explica o breakdown.

`evaluate_event_health` tem guard independente do LLM e exige pedido explícito de reavaliação na mensagem atual.

Exemplos:

```text
"Como está a saúde do casamento da Ana?"
"Qual dos meus eventos está menos saudável?"
"Recalcule o Health Score desse evento."
```

## Segurança e limites

- IA não escolhe score nem severidade.
- `acknowledged` não reduz penalidade.
- Health Score não substitui Risk Engine nem representa progresso do planejamento.
- Riscos resolvidos deixam de participar do próximo cálculo.
- Histórico é append-only; o estado atual também fica materializado no evento para consultas rápidas.
