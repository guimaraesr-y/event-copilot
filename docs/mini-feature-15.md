# Feature 15 — Briefing D-1

## Objetivo

Responder de forma determinística à pergunta **“este evento está pronto para amanhã?”** e entregar automaticamente, na véspera, um briefing operacional por evento.

A Feature 15 reutiliza Brief Engine, scheduler, Transactional Outbox, n8n e Messaging Engine da Feature 14. IA não calcula readiness nem escolhe pendências; o Operational Agent apenas consulta, explica, gera sob solicitação ou configura o schedule.

## Arquitetura

```text
Evento que acontece amanhã
        ↓
Tasks / Milestones / Vendors
Risks / Dependencies / Changes / Inbox
Health Score
        ↓
BriefEngine.generateDMinus1()
        ↓
READY | READY_WITH_WARNINGS | NOT_READY
        ↓
       daily_briefs
(type=d_minus_1, event_id preenchido)
        ↓
brief.delivery_requested
        ↓
Transactional Outbox → Worker → n8n
        ↓
automation_action → outbound_message
        ↓
message_type=d_minus_1_brief → WhatsApp
```

## Readiness determinístico

O readiness não é outro Health Score. Ele responde se existem bloqueadores concretos na véspera.

### `NOT_READY`

É usado quando há ao menos um bloqueador forte, como:

- risco `critical` ativo;
- fornecedor `declined`;
- tarefa aberta com prioridade `critical`;
- dependency impact `critical` ainda aberto;
- Change Proposal sensível ainda pendente;
- item crítico da Operational Inbox.

### `READY_WITH_WARNINGS`

É usado quando não há bloqueadores, mas ainda existem sinais que merecem atenção:

- risco `high`;
- fornecedor pendente;
- tarefa atrasada não crítica;
- milestone aberto;
- dependência aberta não crítica;
- item aberto na Inbox.

### `READY`

Não existem bloqueadores nem warnings relevantes no snapshot atual.

`readinessReasons[]` persiste os motivos utilizados pelo backend, permitindo auditoria e explicação pelo Agent.

## Conteúdo do D-1

O payload estruturado contém:

- identificação, data, horário, local e convidados;
- Health Score/status atual;
- riscos ativos;
- tarefas abertas e atraso;
- milestones ainda abertos;
- fornecedores e confirmation status;
- `arrivalAt` / `departureAt` dos fornecedores;
- dependencies abertas;
- Change Proposals pendentes;
- Operational Inbox aberta;
- timeline operacional ordenada.

A timeline inclui, quando conhecidos:

```text
vendor_arrival
→ event_start
→ event_end
→ vendor_departure
```

## Schedules genéricos

Migration `019_d_minus_1_brief` cria:

```text
organization_brief_schedules
```

Chave:

```text
organization_id + brief_type
```

Tipos atuais:

```text
daily
d_minus_1
```

Cada tipo possui configuração independente:

- `enabled`;
- `local_time` no timezone da organização;
- `channel=whatsapp`;
- `recipient`;
- auditoria de quem alterou.

A migration copia as preferências Daily existentes para `brief_type=daily`, mantendo compatibilidade com a Feature 14.

O default do D-1 é seguro:

```text
enabled = false
local_time = 18:00
recipient = null
```

## Scheduler D-1

`BriefEngine.processDueSchedules()` processa Daily e D-1 no mesmo sweep.

Para D-1:

1. carrega organizações com `d_minus_1` habilitado;
2. converte `now` para o timezone da organização;
3. verifica se o horário configurado já passou;
4. procura eventos ativos cuja data local seja amanhã;
5. gera um D-1 por evento;
6. solicita entrega pelo outbox.

Trigger agendado:

```text
scheduled:d_minus_1:<eventId>:<event-date>
```

A chave é idempotente. Restarts ou sweeps repetidos não geram outra mensagem para o mesmo evento/data.

## Persistência e revisões

A tabela `daily_briefs` passa a aceitar `event_id`:

```text
daily      → event_id = NULL
d_minus_1  → event_id = UUID do evento
```

Revisões D-1 são escopadas por organização + evento + data. Uma geração manual posterior supersede a revisão atual sem apagar o histórico.

A avaliação é event-scoped: o D-1 de Ana & Pedro nunca substitui o D-1 de outro evento da mesma organização.

## Mensageria e n8n

A Feature 15 generaliza a automação de brief:

```text
brief.prepare
```

O endpoint e workflow n8n são comuns a Daily e D-1. O payload informa:

```text
briefType
eventId
eventName
messageType
referenceDate
recipient
text
```

Message types:

```text
daily_brief
d_minus_1_brief
```

Ambos reutilizam o provider (`mock`/`meta`) e tracking padrão `sent/delivered/read/failed`.

O `n8n-init` da stack continua importando/publicando automaticamente `eccDomainEventGw1` antes do worker iniciar.

## API

Schedules:

```text
GET  /api/v1/briefs/schedules
GET  /api/v1/briefs/schedules/:type
POST /api/v1/briefs/schedules/:type
```

D-1:

```text
GET  /api/v1/events/:eventId/briefs/d-minus-1
POST /api/v1/events/:eventId/briefs/d-minus-1/generate
GET  /api/v1/events/:eventId/briefs/d-minus-1/history
GET  /api/v1/briefs?type=d_minus_1
```

## Operational Agent

Tools novas:

```text
get_d_minus_1_brief
generate_d_minus_1_brief
get_d_minus_1_settings
configure_d_minus_1_brief
```

Exemplos:

```text
"Estamos prontos para amanhã?"
"Mostre o briefing D-1 deste casamento."
"Gere novamente o briefing D-1."
"Configure o briefing D-1 para 18h30 neste WhatsApp."
"Desative o briefing da véspera."
```

### Segurança da configuração

Assim como no Daily Brief:

- o texto atual é a fonte autoritativa para ativar/desativar;
- `enabled` produzido pelo LLM é tratado como não confiável;
- `18h30`, `18:30`, `18h` são normalizados no servidor;
- `configure o briefing D-1 para HH:mm` implica criar/ativar o schedule;
- alterar apenas o horário não deve habilitar uma agenda desativada sem intenção de configuração/ativação;
- se faltar destinatário, o horário é salvo, `enabled` permanece falso e o Agent pede o WhatsApp;
- o próximo turno pode conter somente o número quando houver `needsRecipient=true` para `configure_d_minus_1_brief`;
- telefone isolado fora desse estado pendente continua bloqueado.

Daily e D-1 são agendas independentes: configurar uma nunca altera a outra.

## Idempotência

A Feature 15 protege:

- schedule por `organization_id + brief_type`;
- geração por `trigger_key`;
- revisão D-1 por evento/data;
- preparação da mensagem por `automation_action`;
- envio pelo pipeline de Messaging Engine.

## Smoke

O smoke passa a ter 82 etapas e adiciona um evento com início dinâmico para amanhã. Ele valida:

1. configuração D-1 pelo Agent;
2. scheduler reconhece o evento de amanhã;
3. readiness é persistido;
4. `brief.delivery_requested` chega ao n8n;
5. `d_minus_1_brief` é enviado por WhatsApp mock;
6. sweeps repetidos não duplicam brief/mensagem;
7. schedule Daily permanece independente;
8. Agent consulta readiness;
9. API expõe timeline/readiness;
10. geração manual cria nova revisão e é idempotente.

## Próxima etapa

A infraestrutura de schedules e brief por evento deixa a Feature 16 — Event Day Mode — pronta para reutilizar o mesmo modelo operacional em uma visão de execução no dia do evento.
