Eu fecharia o **Event Command Center** como um pequeno sistema distribuído em que o n8n é extremamente importante, mas **não é o sistema inteiro**.

A arquitetura-base seria:

```text
                    ┌──────────────────────┐
                    │   WhatsApp / Email   │
                    │ Calendar / Drive etc │
                    └──────────┬───────────┘
                               │
                               ▼
                         ┌──────────┐
                         │   n8n    │
                         │Orchestr. │
                         └────┬─────┘
                              │
                Commands / Queries / Events
                              │
                              ▼
                    ┌──────────────────┐
                    │ Command Center   │
                    │      API         │
                    │                  │
                    │ Event Engine     │
                    │ Dependency Engine│
                    │ Health Engine    │
                    │ Rules            │
                    └────────┬─────────┘
                             │
                             ▼
                        PostgreSQL
                     SOURCE OF TRUTH
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
          Events          Audit Log        Outbox
          Tasks           Changes          Risks
          Vendors         Messages         Jobs
```

A regra seria:

> **n8n executa processos; backend decide o que é verdade.**

O próprio n8n atualmente oferece Webhooks de produção, sub-workflows, error workflows e nodes nativos do WhatsApp Business Cloud, então ele encaixa muito bem nessa posição. ([GitHub][1])

---

# 1. Stack que eu escolheria

Para o primeiro produto:

```text
Backend
├── TypeScript
├── Bun
├── Hono ou Fastify
├── Kysely
├── PostgreSQL
└── Zod

Automation
├── n8n
└── workflows versionados em JSON

IA
├── LLM com Structured Outputs
└── speech-to-text para áudios

Integrações
├── WhatsApp Business Cloud
├── Google Calendar
├── Google Drive
├── Gmail
└── futuramente gateways/ERPs

Infra
├── Docker Compose
├── PostgreSQL
├── n8n
├── API
└── reverse proxy

Frontend
└── Next.js — não obrigatório no primeiro MVP
```

Eu evitaria colocar NestJS inicialmente porque boa parte da complexidade estará na modelagem de domínio e nos workflows; uma API menor com Hono/Fastify já resolve.

---

# 2. Estrutura do projeto

Eu faria inclusive um monorepo:

```text
event-command-center/

apps/
  api/
  web/
  worker/

packages/
  domain/
  database/
  contracts/
  integrations/
  event-engine/

n8n/
  workflows/
  subworkflows/
  README.md

infra/
  docker/
  compose.yaml

docs/
  architecture/
  event-model/
  workflow-catalog/
```

O `domain` merece existir independentemente do n8n.

Por exemplo:

```text
packages/domain/

event/
vendor/
task/
payment/
guest/
document/
change/
risk/
briefing/
health/
```

---

# 3. Modelo de dados

Aqui está provavelmente a parte mais importante de todo o produto.

## Tenant

Cada cerimonial é uma organização independente.

```text
organizations

id
name
timezone
settings
created_at
```

Tudo precisa carregar:

```text
organization_id
```

desde o começo.

Isso evita uma migração dolorosa quando virar SaaS.

---

## Event

```text
events

id
organization_id

name
type

start_at
end_at

venue_name
venue_address

guest_count

status
health_score

owner_user_id

created_at
updated_at
```

Possíveis estados:

```text
draft
planning
confirmation
ready
event_day
completed
cancelled
```

---

# 4. Fornecedores

Não usaria simplesmente:

```text
event.vendor_id
```

porque um fornecedor participa de vários eventos.

Teríamos:

```text
vendors

id
organization_id

name
category

contact_name
phone
email
```

E:

```text
event_vendors

id
event_id
vendor_id

status

arrival_at
departure_at

team_size

contract_status
payment_status

confirmed_at

notes
```

Categorias:

```text
BUFFET
PHOTO
VIDEO
DECORATION
DJ
BAND
CAKE
SWEETS
VENUE
TRANSPORT
CELEBRANT
SECURITY
OTHER
```

---

# 5. Tasks + Milestones

Não criaria 200 campos específicos no evento.

Muita coisa vira tarefa.

```text
tasks

id
event_id

type
title
description

due_at
status
priority

owner_id

source
created_at
completed_at
```

Com:

```text
source =

MANUAL
TEMPLATE
AI
DEPENDENCY
AUTOMATION
```

Isso vai ser muito útil depois.

---

# 6. Templates de evento

Esse é um dos recursos essenciais.

O cerimonial cria:

> Template: Casamento Premium

```text
D-180
Definir espaço

D-150
Contratar fotografia

D-120
Fechar decoração

D-90
Lista preliminar

D-60
Confirmar fornecedores

D-30
RSVP final

D-15
Briefing fornecedores

D-7
Confirmação geral

D-1
Briefing final
```

Banco:

```text
event_templates

template_tasks
template_vendor_requirements
template_checkpoints
```

Quando cria o evento:

```text
POST /events
        ↓
event.created
        ↓
n8n
        ↓
instantiate template
        ↓
tasks
checkpoints
folders
calendar
```

---

# 7. E precisamos de algo fundamental: Changes

Eu faria **mudanças como entidades de primeira classe**.

Por exemplo:

```text
event_changes

id

event_id

field
old_value
new_value

source
requested_by

risk_level

status

created_at
approved_at
```

Exemplo:

```json
{
  "field": "guest_count",
  "old_value": 120,
  "new_value": 132,
  "source": "WHATSAPP",
  "risk_level": "HIGH",
  "status": "PENDING_APPROVAL"
}
```

Isso é extremamente importante para a IA.

---

# 8. A IA nunca deveria simplesmente editar tudo

Suponha que o cerimonialista mande:

> "Muda a cerimônia da Ana para 17h."

Eu NÃO faria:

```text
LLM
 ↓
UPDATE events
```

Faria:

```text
WhatsApp
    ↓
transcrição
    ↓
LLM extraction
    ↓

{
 event: "Ana & Pedro",
 intent: "CHANGE_EVENT_TIME",
 newTime: "17:00",
 confidence: 0.96
}

    ↓
API
    ↓
validação determinística
    ↓
Change Proposal
```

Então:

```text
⚠ Alteração importante

Ana & Pedro

Cerimônia
18:00 → 17:00

Impactos identificados:
• fotografia
• buffet
• decoração
• DJ

[Confirmar]
[Cancelar]
```

Isso deixa a automação muito mais segura.

---

# 9. Eu criaria três níveis de mudança

### Nível 1 — automática

Pouco risco:

```text
adicionar nota
registrar resposta
marcar confirmação
adicionar observação
```

Pode aplicar direto.

### Nível 2 — operacional

```text
horário chegada fotógrafo
quantidade da equipe
telefone fornecedor
```

Aplica + registra no audit log.

### Nível 3 — crítica

```text
data do evento
horário da cerimônia
número de convidados
valor
cancelamento
local
```

Exige aprovação.

Essa regra não fica no prompt.

Fica no código.

---

# 10. Dependency Engine

Aqui começa a aparecer o grande diferencial.

Eu não usaria IA para determinar tudo.

Criaria regras.

Tabela:

```text
dependency_rules

id
organization_id

source_entity
source_field

condition

target_category
action

severity
```

Por exemplo:

```text
EVENT.guest_count changed
        ↓
BUFFET
DECORATION
SWEETS
CAKE
VENUE
```

Regra:

```text
guest_count
120 → 150
```

gera:

```text
Risk:
BUFFET_QUANTITY_OUTDATED

Risk:
LAYOUT_MAY_BE_OUTDATED

Task:
RECONFIRM_SWEETS

Task:
RECONFIRM_CAKE
```

---

# 11. Event Engine

Eu faria um serviço específico:

```text
EventEngine
```

Responsável por:

```text
createEvent()
changeEvent()
applyChange()
completeTask()
confirmVendor()
detectDependencies()
recalculateHealth()
generateRisks()
```

Exemplo:

```ts
eventEngine.changeEvent({
  eventId,
  field: "guestCount",
  value: 132,
  source: "WHATSAPP",
});
```

Internamente:

```text
validate
↓
classify risk
↓
create change
↓
resolve dependencies
↓
generate tasks/risks
↓
update health
↓
emit domain events
```

Ou seja:

**não queremos n8n fazendo 14 UPDATEs diretamente no Postgres.**

---

# 12. Domain Events

Essa parte combina perfeitamente com n8n.

O backend começa a emitir coisas como:

```text
event.created

event.changed

event.change_proposed

event.change_approved

vendor.confirmation_requested

vendor.confirmed

vendor.overdue

task.created

task.overdue

payment.due

risk.detected

briefing.requested

event.ready
```

Por exemplo:

```text
event.change_approved
            ↓
           n8n
            ↓
     Dependency Workflow
       ↙      ↓       ↘
WhatsApp Calendar   Drive
```

---

# 13. Outbox pattern desde cedo

Eu implementaria.

Quando algo acontece:

```text
BEGIN

UPDATE event

INSERT event_change

INSERT outbox_event

COMMIT
```

Tabela:

```text
outbox_events

id
organization_id
event_type
aggregate_type
aggregate_id
payload

created_at
dispatched_at
attempts
```

Depois:

```text
worker
↓
n8n webhook
↓
200 OK
↓
dispatched_at
```

Isso impede situações como:

```text
Banco atualizou
     ↓
processo caiu
     ↓
WhatsApp nunca enviado
```

---

# 14. Idempotência

Seria obrigatória.

Principalmente WhatsApp/webhooks.

Algo como:

```text
processed_events

source
external_id

processed_at
```

Unique:

```text
(source, external_id)
```

Se Meta enviar duas vezes:

```text
wamid.xxx
wamid.xxx
```

segunda execução:

```text
already processed
→ IGNORE
```

Isso evita exatamente o tipo de bug de concorrência/duplicação que aparece bastante em sistemas de automação.

---

# 15. Catálogo inicial de workflows n8n

Em vez de um mega-workflow:

```text
EVENT COMMAND CENTER ██████████████
```

eu teria vários workflows pequenos. O próprio n8n oferece `Execute Sub-workflow`, então essa decomposição é suportada diretamente pela plataforma. ([n8n Documentation][2])

### Entradas

```text
WF-001 whatsapp-inbound
WF-002 email-inbound
WF-003 api-domain-event
WF-004 scheduled-event-scan
```

### Eventos

```text
WF-010 event-created
WF-011 event-updated
WF-012 event-change-approved
```

### Fornecedores

```text
WF-020 vendor-confirmation-request
WF-021 vendor-response
WF-022 vendor-reminder
```

### Comunicação

```text
WF-030 daily-command-brief
WF-031 client-notification
WF-032 team-notification
```

### Documentos

```text
WF-040 create-event-drive
WF-041 generate-event-briefing
```

### Event Day

```text
WF-050 event-day-start
WF-051 event-day-checkpoint
WF-052 supplier-delay
```

### Sistema

```text
WF-900 error-handler
WF-901 dead-letter
WF-902 health-check
```

Error workflows existem justamente para executar outro workflow quando uma execução falha, então eu teria um `WF-900` compartilhado para alerta e recuperação. ([n8n Documentation][3])

---

# 16. E vários sub-workflows reutilizáveis

```text
SUB-send-whatsapp

SUB-send-email

SUB-transcribe-audio

SUB-call-llm

SUB-resolve-event

SUB-create-calendar-event

SUB-create-drive-folder

SUB-format-message

SUB-retry-external-api
```

Isso evita duplicação.

---

# 17. Como funcionaria o WhatsApp

O n8n atualmente tem node nativo para WhatsApp Business Cloud e um WhatsApp Trigger para eventos recebidos. ([n8n Documentation][4])

Entrada:

```text
WhatsApp
↓
WhatsApp Trigger
↓
normalize message
↓
identify organization
↓
identify sender
↓
resolve event
↓
classify intent
```

Intent:

```text
QUERY_EVENT
CHANGE_EVENT
CREATE_TASK
CONFIRM_VENDOR
ADD_NOTE
GENERATE_BRIEF
UNKNOWN
```

---

# 18. Resolver sobre qual evento o usuário está falando

Esse problema é mais importante do que parece.

Usuário manda:

> "O fotógrafo confirmou 14h30."

Qual evento?

Eu manteria:

```text
conversation_context

organization_id
phone_number

current_event_id

last_interaction_at
```

Se há um evento contextual:

```text
current_event = Ana & Pedro
```

entendemos.

Caso exista ambiguidade:

```text
Encontrei dois eventos próximos:

1. Ana & Pedro — 17/10
2. Laura 15 anos — 18/10

Qual deles?
```

Nunca deixar o LLM escolher silenciosamente.

---

# 19. Voice Command

Pipeline:

```text
WhatsApp audio
      ↓
download media
      ↓
speech-to-text
      ↓
normalize text
      ↓
LLM structured extraction
      ↓
Zod validation
      ↓
Command
```

Resultado:

```json
{
  "commands": [
    {
      "type": "CHANGE_GUEST_COUNT",
      "value": 132
    },
    {
      "type": "CONFIRM_VENDOR",
      "vendor": "fotografia",
      "arrivalTime": "14:30"
    },
    {
      "type": "CREATE_TASK",
      "title": "Confirmar 6 vegetarianos com buffet"
    }
  ]
}
```

Essa etapa pode extrair **vários comandos de um áudio**.

Muito importante.

---

# 20. Daily Command Brief

Schedule n8n:

```text
07:00
 ↓
GET /organizations/:id/daily-brief
 ↓
Backend calcula
 ↓
n8n formata/distribui
```

API retorna:

```json
{
  "critical": [...],
  "warnings": [...],
  "today": [...],
  "upcoming": [...]
}
```

Não faria o LLM decidir quais eventos são críticos.

O backend decide.

LLM apenas transforma em uma mensagem agradável.

---

# 21. Health Score

Também **determinístico**.

Inicialmente:

```text
100 pontos
```

Penalidades:

```text
tarefa crítica atrasada
-10

fornecedor não confirmado D-7
-10

pagamento vencido
-15

documento obrigatório ausente
-8

mudança crítica não resolvida
-15

risco crítico aberto
-20
```

Mas o fator tempo muda a severidade.

Por exemplo:

```text
Fotógrafo não confirmado

D-90 → -1
D-30 → -3
D-7  → -10
D-1  → -25
```

Isso é importante.

A mesma pendência fica mais grave conforme o evento se aproxima.

---

# 22. Risk Engine

Tabela:

```text
risks

id
event_id

type
severity

source_type
source_id

title
description

status

detected_at
resolved_at
```

Exemplos:

```text
VENDOR_NOT_CONFIRMED

PAYMENT_OVERDUE

GUEST_COUNT_CHANGED

SCHEDULE_CONFLICT

REQUIRED_DOCUMENT_MISSING

TASK_OVERDUE

SUPPLIER_DELAY

EVENT_TIME_CHANGED
```

---

# 23. Briefing automático

O briefing não deveria ser simplesmente:

> “LLM, leia isso tudo e faça um PDF.”

Backend cria estrutura:

```json
{
  "event": {},
  "timeline": [],
  "vendors": [],
  "guests": {},
  "dietaryRestrictions": [],
  "specialInstructions": [],
  "risks": []
}
```

Então o LLM pode auxiliar somente na apresentação.

Assim você nunca perde algo crítico porque a IA decidiu resumir demais.

---

# 24. Event Day Mode

Quando:

```text
event.start_at - N horas
```

Estado:

```text
PLANNING
    ↓
EVENT_DAY
```

Os workflows mudam.

Antes:

```text
dias
semanas
checklists
```

Agora:

```text
minutos
horários
chegadas
incidentes
```

Endpoint:

```text
/events/:id/timeline/live
```

Resposta:

```text
14:00 decoração        ✓
14:30 fotografia       ✓
15:00 bolo             ⚠
15:30 DJ               ○
16:00 buffet           ○
17:00 convidados       ○
17:30 cerimônia        ○
```

---

# 25. Features: o MVP que eu realmente construiria

Aqui eu faria um corte agressivo.

| Feature                              | MVP | Responsável        |
| ------------------------------------ | --: | ------------------ |
| Cadastro de eventos                  |   ✅ | Backend            |
| Templates de evento                  |   ✅ | Backend            |
| Tasks/milestones                     |   ✅ | Backend            |
| Cadastro de fornecedores             |   ✅ | Backend            |
| Confirmação automática de fornecedor |   ✅ | n8n                |
| WhatsApp inbound/outbound            |   ✅ | n8n                |
| Comandos por texto                   |   ✅ | AI + Backend       |
| Comandos por áudio                   |   ✅ | AI + n8n           |
| Daily Command Brief                  |   ✅ | Backend + n8n      |
| Change Proposal                      |   ✅ | Backend            |
| Aprovação de mudanças críticas       |   ✅ | Backend + WhatsApp |
| Audit log                            |   ✅ | Backend            |
| Risk Engine básico                   |   ✅ | Backend            |
| Health Score                         |   ✅ | Backend            |
| Briefing D-1                         |   ✅ | Backend + n8n      |
| Drive automático                     |   ✅ | n8n                |
| Calendar automático                  |   ✅ | n8n                |
| Event Day timeline                   |  🟡 | MVP+               |
| Dependency Engine completo           |  🟡 | MVP+               |
| Dashboard web                        |  🟡 | MVP+               |
| Supplier Reliability                 |   ❌ | V2                 |
| Portal cliente                       |   ❌ | V2                 |
| RSVP completo                        |   ❌ | V2                 |
| Financeiro completo                  |   ❌ | V2                 |
| Marketplace fornecedores             |   ❌ | futuro             |

---

# 26. Eu adicionaria uma feature ao MVP: “Inbox operacional”

Essa acho importante.

Todas as informações novas entram em:

```text
Operational Inbox

09:31
João Fotografia confirmou chegada 14:30

09:40
Cliente pediu alteração para 132 convidados

09:43
Buffet enviou novo PDF

10:12
Parcela confirmada
```

Isso vira:

```text
messages
```

e:

```text
activity_log
```

Uma timeline imutável do evento.

---

# 27. Audit Log

Exemplo:

```text
10:42 Ryan
Alterou convidados
120 → 132

Origem:
WhatsApp

10:42 Sistema
Criou risco
BUFFET_QUANTITY_OUTDATED

10:42 Sistema
Criou tarefa
Reconfirmar quantidade com buffet

10:43 Ryan
Aprovou alteração
```

Isso vai ser extremamente importante para empresas maiores.

---

# 28. Frontend quando chegar a hora

Eu faria somente quatro telas inicialmente.

### `/events`

```text
EVENTOS

🔴 Ana & Pedro       17/10     63%
🟡 Laura 15 anos     24/10     81%
🟢 João & Maria      31/10     96%
```

### `/events/:id`

```text
Ana & Pedro

Health 81%

Timeline
Tasks
Vendors
Guests
Documents
Payments
Changes
Risks
Activity
```

### `/inbox`

```text
Mudanças esperando aprovação
Riscos
Mensagens
```

### `/settings/templates`

Templates e automações.

Só.

---

# 29. Uma feature visual muito boa: Event Pulse

Na página inicial:

```text
EVENT PULSE

            EVENTS
              18

        🟢 12
        🟡  4
        🔴  2


ATENÇÃO AGORA

Ana & Pedro
Fotógrafo não confirmado

Laura 15 anos
Pagamento buffet vencido

Carlos & Júlia
Lista precisa fechar hoje
```

Esse pode virar o principal argumento comercial.

---

# 30. Infra inicial

Eu começaria simples:

```text
docker compose

postgres
api
worker
n8n
redis? não inicialmente
reverse-proxy
```

No início, um n8n normal é suficiente.

Quando houver volume/concor­rência relevante, podemos migrar para Queue Mode. A arquitetura atual do n8n para queue mode usa Redis como broker e workers para processar as execuções, mantendo a persistência no banco; também é possível separar processors de webhook para escalar a recepção de requisições. ([GitHub][5])

Então nossa arquitetura já fica preparada para:

```text
               Redis
                 │
         ┌───────┴───────┐
         ↓               ↓
    n8n worker 1     n8n worker 2
         ↓               ↓
         └───────┬───────┘
                 ↓
             Postgres
```

Mas não precisamos dessa complexidade no começo.

---

# 31. Arquitetura funcional final

Eu vejo cinco engines:

```text
                    EVENT COMMAND CENTER

                           EVENT
                             │
           ┌─────────────────┼──────────────────┐
           │                 │                  │
           ▼                 ▼                  ▼
      Event Engine     Dependency Engine    Risk Engine
           │                 │                  │
           └─────────────────┼──────────────────┘
                             ▼
                        Health Engine
                             │
                             ▼
                        Command Engine
                             │
                             ▼
                            n8n
                  ┌──────────┼──────────┐
                  ↓          ↓          ↓
              WhatsApp     Drive     Calendar
```

E isso nos dá uma divisão arquitetural muito saudável:

**Event Engine:** o que aconteceu?

**Dependency Engine:** o que essa mudança afeta?

**Risk Engine:** existe algum problema?

**Health Engine:** quão saudável está o evento?

**Command Engine:** o que o usuário está pedindo?

**n8n:** o que precisa ser executado fora do sistema?

Essa, para mim, já é a base técnica do **Event Command Center v1**.

O próximo passo que eu faria seria descer mais um nível e transformar isso em uma **especificação implementável**: modelo relacional completo do PostgreSQL, contratos dos Domain Events, endpoints da API e desenho node-a-node dos ~10 workflows n8n do MVP. A partir daí já deixa de ser brainstorm e vira praticamente o blueprint do repositório.

[1]: https://github.com/n8n-io/n8n-docs/blob/main/docs/integrations/builtin/core-nodes/n8n-nodes-base.webhook/README.md?utm_source=chatgpt.com "n8n-docs/docs/integrations/builtin/core-nodes/n8n-nodes-base.webhook/README.md at main · n8n-io/n8n-docs · GitHub"
[2]: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow?utm_source=chatgpt.com "Execute Sub-workflow | Nodes"
[3]: https://docs.n8n.io/build/flow-logic/handle-errors-gracefully?utm_source=chatgpt.com "Handle errors gracefully | Build"
[4]: https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.whatsapp?utm_source=chatgpt.com "WhatsApp Business Cloud | Nodes"
[5]: https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode.md?utm_source=chatgpt.com "n8n-docs/docs/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode.md at main · n8n-io/n8n-docs · GitHub"
