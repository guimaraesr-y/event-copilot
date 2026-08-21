# Mini Feature 16.1 — Event Day Operations

**Versão:** `0.16.1`

## Objetivo

Transformar o Event Day Mode em uma capacidade operacional opcional por evento, com tasks de execução e incidentes durante o evento, sem transformar o ECC inteiro em um “modo global”.

Princípio:

> Event Day pertence ao evento. Outros eventos continuam planejáveis e operáveis normalmente.

## Opt-in por evento

A migration `021_event_day_operations` cria `event_day_settings` com configuração independente por `(organization_id, event_id)`.

O default é:

```text
enabled = false
```

Estados conceituais:

```text
desabilitado
   ↓ enable
habilitado / sem sessão
   ↓ start
sessão ativa
   ↓ complete
habilitado / sessão concluída

sessão ativa
   ↓ disable
sessão concluída(reason=disabled) + capacidade desabilitada
```

`enable` não inicia a operação. `start` exige Event Day habilitado e a data local do evento. `disable` nunca altera outros eventos.

## Sessão não é ciclo de vida do evento

A sessão persiste `previous_event_status`. Ao concluir ou desativar uma sessão ativa, esse status é restaurado.

Portanto:

```text
complete_event_day != complete_event
```

Encerrar a operação ao vivo não marca silenciosamente o evento como `completed`.

A restrição antiga de uma única sessão histórica por evento foi substituída por uma restrição parcial: só pode existir **uma sessão ativa** por evento. Sessões concluídas são preservadas como histórico e o Event Day pode ser iniciado novamente.

## Tasks operacionais

Não existe um segundo sistema de tasks. A mesma tabela `event_tasks` recebe:

```text
phase = planning | event_day
```

Para `phase=event_day`:

```text
event_day_kind = checklist | operation | incident
```

Isso permite usar a infraestrutura já existente de status, prioridade, timestamps, tenant scoping e outbox.

Exemplos:

```text
checklist  → Conferir microfones
operation  → Posicionar padrinhos
incident   → Gerador parou
```

Incidentes defaultam para prioridade `high`; o Agent pode criar `critical` quando a mensagem indicar urgência/bloqueio.

## Estado ao vivo

O snapshot adiciona:

```text
enabled
counts.tasks
counts.openTasks
counts.overdueTasks
counts.criticalOpenTasks
counts.incidents
counts.openIncidents
counts.criticalOpenIncidents
counts.resolvedIncidents
```

Status possíveis:

```text
disabled
not_started
on_track
attention
critical
completed
```

Regras fortes de `critical` incluem incidente `critical` aberto, fornecedor recusado, task crítica atrasada e atraso crítico de fornecedor.

Incidente aberto não crítico, task atrasada e fornecedor atrasado/due podem elevar para `attention`.

## API

```http
GET  /api/v1/events/:eventId/event-day
POST /api/v1/events/:eventId/event-day/enable
POST /api/v1/events/:eventId/event-day/disable
POST /api/v1/events/:eventId/event-day/start
POST /api/v1/events/:eventId/event-day/complete

POST /api/v1/events/:eventId/event-day/vendors/:eventVendorId/arrive
POST /api/v1/events/:eventId/event-day/vendors/:eventVendorId/depart

POST /api/v1/events/:eventId/event-day/tasks
POST /api/v1/events/:eventId/event-day/tasks/:taskId/start
POST /api/v1/events/:eventId/event-day/tasks/:taskId/complete
POST /api/v1/events/:eventId/event-day/tasks/:taskId/cancel
POST /api/v1/events/:eventId/event-day/incidents/:taskId/resolve
```

## Operational Agent

Tools adicionadas:

```text
enable_event_day
disable_event_day
create_event_day_task
start_event_day_task
complete_event_day_task
resolve_event_day_incident
```

Mantidas:

```text
get_event_day_status
start_event_day
mark_event_day_vendor_arrived
mark_event_day_vendor_departed
complete_event_day
```

Semântica protegida pelo servidor:

```text
“Ative o Event Day”   → habilita
“Inicie o Event Day”  → abre sessão
“Desative o Event Day”→ encerra sessão ativa, se houver, e desabilita
```

Writes de tasks/incidentes exigem intenção explícita. O modelo interpreta linguagem; o backend valida e persiste a verdade operacional.

## Eventos de domínio

```text
event_day.enabled
event_day.disabled
event_day.started
event_day.completed
event_day.vendor_arrived
event_day.vendor_departed
event_day.task_created
event_day.task_started
event_day.task_completed
event_day.task_cancelled
event_day.incident_resolved
```

Nenhum workflow n8n novo foi necessário. Esses eventos seguem o outbox e podem ser tratados externamente no futuro, mas o estado crítico permanece no backend/PostgreSQL.

## Smoke

A cobertura end-to-end vai até `102/102` e valida:

- Event Day desabilitado por padrão;
- start bloqueado enquanto desabilitado;
- enable e start como ações distintas;
- task operacional no mesmo `event_tasks`;
- criação e resolução de incidente crítico;
- horários reais separados dos planejados;
- conclusão da sessão restaurando `events.status`;
- segunda sessão no mesmo evento;
- disable durante sessão ativa;
- isolamento de outro evento;
- outbox totalmente drenado.

## Próxima feature

A Feature 17 — Dashboard pode consumir diretamente o snapshot consolidado de Event Day, incluindo fornecedores, tasks, incidentes, timeline e próximas ações.
