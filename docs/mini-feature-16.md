# Mini Feature 16 — Event Day Mode

**Versão:** `0.16.0`

## Objetivo

Transformar o Event Command Center de um sistema de preparação para um sistema de execução ao vivo no dia do evento.

O Briefing D-1 responde:

```text
"estamos prontos para amanhã?"
```

O Event Day Mode responde:

```text
"como está o evento agora e o que precisa acontecer em seguida?"
```

A Feature 16 continua seguindo a regra central do produto:

> n8n executa processos; o backend decide o que é verdade.

Status, atraso, presença real de fornecedores e próximas ações são calculados deterministicamente pelo backend. O LLM nunca escolhe o estado operacional.

## Persistência

Migration:

```text
020_event_day_mode
```

Novos campos em `event_vendors`:

```text
actual_arrival_at
actual_departure_at
```

Os campos existentes continuam sendo planejamento:

```text
arrival_at       -> chegada planejada
departure_at      -> saída planejada
actual_arrival_at -> chegada real
actual_departure_at -> saída real
```

Uma chegada real **nunca sobrescreve** o horário contratado/planejado.

Novas tabelas:

```text
event_day_sessions
event_day_activity
```

`event_day_sessions` possui uma sessão por evento e controla:

```text
active
completed
```

`event_day_activity` mantém o audit trail real:

```text
event_day.started
vendor.arrived
vendor.departed
event_day.completed
```

Cada write também publica um Domain Event na transactional outbox.

## Event Day Engine

Novo engine:

```text
EventDayEngine
```

Operações:

```text
get
start
markVendorArrived
markVendorDeparted
complete
```

O engine só permite iniciar o Event Day na data local do próprio evento.

Lifecycle:

```text
planning/confirmation/ready
          ↓ start
       event_day
          ↓ complete
       completed
```

Eventos `cancelled` ou `completed` não podem iniciar Event Day.

## Status operacional

O snapshot possui:

```text
not_started
on_track
attention
critical
completed
```

O status é diferente de Health Score e Readiness D-1.

### Fornecedor

Cada fornecedor possui `liveStatus`:

```text
unscheduled
not_due
due
late
arrived
departed
```

Defaults da primeira versão:

```text
grace de chegada = 15 min
atraso crítico    = 30 min
```

Exemplo:

```text
arrivalAt = 17:00
agora     = 17:48
actualArrivalAt = null

liveStatus = late
minutesLate = 48
```

Após o check-in:

```text
plannedArrivalAt = 17:00  # preservado
actualArrivalAt  = 17:49
liveStatus       = arrived
```

### Regras do snapshot

`critical` quando existe pelo menos um dos seguintes:

- fornecedor recusado;
- fornecedor com atraso >= 30 minutos;
- tarefa crítica atrasada.

`attention` quando existe:

- fornecedor atrasado abaixo do threshold crítico;
- fornecedor na janela de chegada;
- tarefa crítica aberta;
- tarefa atrasada.

Caso contrário, uma sessão ativa fica `on_track`.

## Timeline ao vivo

O snapshot combina itens planejados e reais:

```text
planned
- chegada de fornecedor
- início do evento
- fim previsto
- saída de fornecedor

actual
- Event Day iniciado
- fornecedor chegou
- fornecedor saiu
- Event Day concluído
```

Isso permite ao futuro Dashboard renderizar uma única linha do tempo sem reconstruir regras no frontend.

## Próximas ações

`nextActions` é calculado pelo backend e prioriza:

1. tarefa crítica atrasada;
2. fornecedor atrasado;
3. fornecedor na janela de chegada;
4. próximo marco planejado.

Nenhuma ação é inventada pelo LLM.

## API

```text
GET  /api/v1/events/:eventId/event-day
POST /api/v1/events/:eventId/event-day/start
POST /api/v1/events/:eventId/event-day/vendors/:eventVendorId/arrive
POST /api/v1/events/:eventId/event-day/vendors/:eventVendorId/depart
POST /api/v1/events/:eventId/event-day/complete
```

Writes aceitam:

```json
{
  "sender": "planner"
}
```

Retry de start/check-in/check-out/complete é idempotente quando o estado já foi aplicado.

## Operational Agent

Tools:

```text
get_event_day_status
start_event_day
mark_event_day_vendor_arrived
mark_event_day_vendor_departed
complete_event_day
```

Exemplos:

```text
"Como está o evento agora?"
"Inicie o Event Day deste casamento."
"O fotógrafo chegou agora."
"O fotógrafo saiu."
"Finalize o Event Day deste evento."
```

Regras de segurança:

- start exige pedido explícito atual;
- complete exige pedido explícito atual;
- chegada só é registrada após afirmação explícita de chegada;
- saída só é registrada após afirmação explícita de saída;
- referência de fornecedor ambígua é bloqueada;
- Agent resolve nome/categoria contra o snapshot do backend;
- planned e actual permanecem separados.

## n8n

Nenhum workflow novo foi criado nesta feature.

Os Domain Events de Event Day entram na outbox e passam pelo gateway existente. Como não há efeito externo necessário nesta versão, o gateway os reconhece pelo caminho de evento não tratado.

Isso é intencional: check-in/check-out é estado de negócio e pertence ao backend.

## Smoke

O smoke passa de 82 para 90 etapas e adiciona:

1. evento criado para a data atual;
2. fornecedor com chegada planejada 45 minutos no passado;
3. snapshot `not_started` detectando atraso;
4. start mudando lifecycle para `event_day`;
5. status `critical` por atraso >= 30 min;
6. consulta através do Operational Agent;
7. chegada real registrada pelo Agent;
8. prova de que `arrival_at` não foi sobrescrito;
9. saída real e timeline;
10. conclusão pelo Agent e lifecycle `completed`;
11. outbox totalmente drenada.

## Próxima etapa

```text
17 Dashboard
```

O Dashboard poderá consumir diretamente:

```text
Event Day snapshot
D-1 readiness
Health Score
Risk Engine
Operational Inbox
Activity
```

sem duplicar regras de domínio no frontend.
