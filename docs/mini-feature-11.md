# Mini-feature 11 — Dependency Engine

A Dependency Engine transforma uma mudança sensível **já aprovada e aplicada** em consequências operacionais persistidas, auditáveis e controladas.

## Objetivo

Antes desta feature, `ChangeProposalEngine` detectava impactos de alto nível antes da aprovação, mas não havia uma representação operacional das dependências depois que a mudança entrava em vigor.

Agora:

```text
Change Proposal
      ↓ aprovação
change.applied
      ↓ Outbox / Worker
DependencyEngine
      ↓
dependency_impacts
      ├── suggest_update
      └── review
```

A avaliação é idempotente por `source_change_event_id`.

## Tipos de dependência

```text
task_due_date
milestone_due_date
vendor_schedule
vendor_reconfirmation
guest_capacity_review
venue_logistics_review
manual_schedule_review
```

Cada impacto possui:

- entidade afetada;
- regra que o gerou (`rule_key`);
- snapshot do valor atual;
- sugestão, quando calculável;
- severidade;
- status;
- referência à proposta e ao `change.applied` de origem.

## Regras atuais

### Mudança de data

Itens de template abertos são determinísticos:

- task de template → sugere deslocamento pelo mesmo número de dias;
- milestone de template → sugere deslocamento pelo mesmo número de dias;
- chegada/saída de fornecedor confirmado → sugere deslocamento em dias preservando horário local.

Não determinísticos:

- tasks manuais/automation/AI abertas → `manual_schedule_review`;
- fornecedor já confirmado → `vendor_reconfirmation`.

A mudança usa calendário local da organização, evitando transformar “+7 dias” em deslocamentos incorretos ao atravessar DST/timezones.

### Mudança de horário

Para fornecedores confirmados com agenda cadastrada:

```text
17:30 → 17:00
arrival/departure → sugestão de -30 min
```

A sugestão não é aplicada automaticamente.

### Mudança de convidados

Fornecedores de categorias dependentes de quantidade viram review:

```text
buffet
venue
cake
sweets
security
```

Mudanças >= 25% são tratadas como `critical` pelas regras atuais.

### Mudança de local

Fornecedores confirmados recebem `venue_logistics_review` para acesso, deslocamento, montagem e horários. Se não houver fornecedor confirmado, é criado um review no próprio evento.

## Stale-state protection

Antes de aplicar uma sugestão, o repository trava e relê a entidade afetada. O valor precisa coincidir com `current_value` salvo no impacto.

Exemplo:

```text
Dependency evaluada: task dueAt = 10/10
Usuário altera task manualmente para 11/10
Agent tenta aplicar sugestão antiga
        ↓
DEPENDENCY_CONFLICT
```

O engine nunca sobrescreve silenciosamente uma edição posterior.

## Status

```text
open
 ├── applied      sugestão calculada aplicada
 ├── resolved     revisão humana concluída
 └── dismissed    impacto considerado não aplicável
```

## Worker

O worker avalia `change.applied` antes de projetar/entregar o evento.

Se o transporte n8n falhar depois da avaliação, o retry é seguro porque `source_change_event_id` impede recriação das dependências.

Os novos Domain Events são:

```text
dependency.detected
dependency.evaluation_completed
dependency.applied
dependency.resolved
dependency.dismissed
```

`OperationalProjector` transforma `dependency.detected` em Inbox e resolve/descarta o item quando a dependência é finalizada.

## API

```text
GET  /api/v1/dependencies
GET  /api/v1/dependencies/:id
POST /api/v1/dependencies/:id/apply
POST /api/v1/dependencies/:id/resolve
POST /api/v1/dependencies/:id/dismiss
POST /api/v1/change-proposals/:id/dependencies/apply-suggestions
```

Filtros de listagem:

```text
eventId
proposalId
status
action
type
limit
```

## Operational Agent

Tools adicionadas:

```text
get_dependency_impacts
apply_dependency_suggestion
apply_dependency_suggestions
resolve_dependency_review
```

A aplicação possui guard independente do prompt. O provider só consegue executar uma sugestão se a **mensagem atual** contiver autorização explícita para recalcular/aplicar o ajuste.

Fluxo esperado:

```text
Planner: "Aprova a mudança de horário."
Agent:   "Alteração aplicada."

Planner: "O que isso impactou?"
Agent:   consulta get_dependency_impacts

Planner: "Pode recalcular todos os ajustes seguros."
Agent:   apply_dependency_suggestions
```

Reviews não são encerrados por `apply_dependency_suggestions`; continuam no Inbox até confirmação humana.

O bulk aplica sugestões item a item de forma idempotente e stale-aware. Se uma entidade mudou depois da avaliação, apenas aquele impacto falha; os ajustes seguros já aplicados não são revertidos, e o resultado informa as falhas parciais.

## Migration

```text
015_dependency_engine
```

Tabelas:

```text
dependency_evaluations
dependency_impacts
```

`dependency_evaluations` registra a execução mesmo quando o resultado possui zero impactos, garantindo idempotência completa do `change.applied`.

A constraint unique principal é:

```text
organization_id
source_change_event_id
rule_key
entity_type
entity_id
```

## Smoke

O smoke passa a ter 55 etapas e adiciona cobertura para:

1. geração automática após `change.applied`;
2. API de dependencies;
3. projeção no Inbox;
4. aplicação via Operational Agent determinístico;
5. alteração real da agenda do fornecedor;
6. Activity e resolução do Inbox.
