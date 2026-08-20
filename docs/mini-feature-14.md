# Feature 14 — Daily Command Brief

## Objetivo

Transformar o estado operacional já calculado por Tasks, Vendors, Dependency Engine, Risk Engine, Inbox e Health Score em um resumo diário persistido, priorizado e entregável ao operador.

O Brief Engine é determinístico. IA não decide score, risco nem prioridade; o Operational Agent consulta o brief e administra sua configuração.

## Arquitetura

```text
PostgreSQL
  ├─ events.health_score
  ├─ event_risks
  ├─ event_tasks
  ├─ event_vendors
  ├─ dependency_impacts
  ├─ change_proposals
  └─ inbox_items
          ↓
      BriefEngine
          ↓
      daily_briefs
          ↓
brief.delivery_requested
          ↓
Transactional Outbox
          ↓
        Worker
          ↓
         n8n
          ↓
automation_action → outbound_message → provider
```

## Preferências por organização

Migration `018_daily_brief` cria `organization_brief_preferences`.

Campos principais:

- `enabled`: opt-in do envio automático;
- `local_time`: `HH:mm` no timezone da organização;
- `channel`: atualmente `whatsapp`;
- `recipient`: telefone normalizado;
- `updated_by_sender`: origem da última configuração.

Defaults seguros:

```text
enabled = false
local_time = 08:00
recipient = null
```

Uma preferência não pode ficar habilitada sem destinatário.

## Scheduler

O worker executa `BriefEngine.processDueSchedules()` conforme:

```env
BRIEF_SCHEDULER_INTERVAL_MS=60000
```

Para cada organização habilitada:

1. converte `now` para o timezone do tenant;
2. verifica se `local_time` já passou;
3. gera o brief da data local;
4. solicita a entrega.

A geração agendada usa:

```text
trigger_key = scheduled:YYYY-MM-DD
```

A constraint única `(organization_id, trigger_key)` garante que restart, retry ou múltiplos sweeps não causem novo envio no mesmo dia.

Se a organização habilitar o brief depois do horário configurado e ainda não houver geração agendada naquele dia, o próximo sweep gera o brief imediatamente.

## Revisões e histórico

`daily_briefs` preserva todas as gerações.

Uma nova geração manual/Agent para a mesma data:

```text
revision 1 generated
      ↓
revision 1 superseded
revision 2 generated
```

O histórico não é apagado.

Chaves manuais e do Agent também são idempotentes por `trigger_key`.

## Conteúdo determinístico

O brief agrega apenas eventos ativos e calcula:

- Health Score atual;
- riscos ativos, críticos e altos;
- tarefas atrasadas;
- tarefas que vencem no dia local;
- fornecedores pendentes/recusados;
- dependências abertas;
- Change Proposals pendentes;
- Operational Inbox aberta.

### Priority score

O `priorityScore` de cada evento combina sinais auditáveis:

```text
(100 - healthScore) × 0.45
+ riscos críticos × 20
+ riscos altos × 12
+ tarefas atrasadas (cap)
+ tarefas de hoje (cap)
+ fornecedores recusados
+ dependências abertas (cap)
+ inbox crítico
```

O resultado é limitado a `0–100` e serve apenas para ordenação do brief. Ele não substitui Risk Score nem Health Score.

### Priority items

A lista de prioridades considera, em ordem de score:

- riscos ativos;
- tarefas atrasadas/hoje;
- dependências abertas;
- fornecedores recusados;
- Change Proposals pendentes.

No máximo dez itens ficam no payload estruturado; o texto matinal mostra os cinco primeiros.

## Texto de entrega

O texto enviado por WhatsApp é renderizado deterministicamente pelo backend. Exemplo:

```text
Bom dia! Brief operacional de 2026-08-19.

3 eventos ativos · 2 tarefas atrasadas · 1 fornecedor pendente.

🔴 Ana & Pedro — 58/100
• 1 risco crítico · 2 tarefas atrasadas

Prioridades de hoje:
1. Buffet ainda não confirmou — Ana & Pedro
2. Confirmar transporte — Ana & Pedro
```

Isso mantém o agendamento independente da disponibilidade/custo do LLM. O Agent continua sendo a interface para consultar e configurar o brief.

## Mensageria e n8n

### Bootstrap do gateway no ambiente local

O envio agendado depende do production webhook `POST /webhook/ecc-domain-events`. O arquivo JSON montado em `/files/n8n` é apenas a fonte do workflow; ele precisa existir no banco do n8n e estar publicado.

O `compose.yaml` inclui `n8n-init`, um serviço one-shot que importa/publica `eccDomainEventGw1` antes do runtime do n8n. O `worker` também depende do n8n saudável, evitando iniciar o dispatcher enquanto o gateway ainda não subiu. Para alterações do workflow durante desenvolvimento, use `./scripts/n8n-sync.sh`.


Quando `requestDelivery=true`, a mesma transação que persiste o brief grava:

```text
brief.delivery_requested
```

O n8n:

1. verifica assinatura do Domain Event;
2. cria `automation_action` `daily_brief.prepare`;
3. chama `MessagingEngine.prepareDailyBrief()`;
4. cria `outbound_message` `message_type=daily_brief`;
5. chama o provider padrão (`mock` ou `meta`).

A partir daí a mensagem usa o mesmo tracking `sent/delivered/read/failed` das demais mensagens.

## API

```text
GET  /api/v1/briefs/settings
POST /api/v1/briefs/settings
GET  /api/v1/briefs/today
POST /api/v1/briefs/generate
GET  /api/v1/briefs
GET  /api/v1/briefs/:briefId
```

Exemplo de configuração:

```json
{
  "enabled": true,
  "localTime": "07:30",
  "recipient": "+5521999999999"
}
```

## Operational Agent

Tools adicionadas:

```text
get_daily_brief
generate_daily_brief
get_brief_history
get_daily_brief_settings
configure_daily_brief
```

Exemplos:

```text
"Qual o brief de hoje?"
"Gere novamente o brief de hoje."
"Que horas meu brief está configurado?"
"Me manda o brief todo dia às 07:30 neste WhatsApp."
"Desative o brief diário."
```

`configure_daily_brief` e `generate_daily_brief` possuem guards server-side e só são executadas quando a mensagem atual contém intenção explícita.

Para configuração do schedule, o texto atual do usuário é a fonte autoritativa para ativar/desativar o brief. O payload produzido pelo LLM é tratado como não confiável: valores como `enabled: "true"`, `1` ou um boolean incorreto não conseguem ligar/desligar a preferência por conta própria. O horário também é normalizado server-side a partir de formas naturais como `21h50`, `21:50`, `7h30` ou `7h`.

Quando o Agent é acessado pelo próprio WhatsApp, o `sender` pode ser usado como destinatário de fallback ao habilitar a configuração. No CLI/local, em que o sender pode ser `planner-local`, uma ativação sem telefone salva o horário mas mantém `enabled=false` e pede explicitamente um número de WhatsApp.

Quando o Agent pede esse número, o turno fica marcado estruturalmente com `needsRecipient=true`. O próximo turno pode então responder somente `envie para 21996570056` (ou apenas o número): esse complemento é aceito como continuação da mesma configuração, salva o destinatário e conclui a ativação. Um telefone isolado fora desse estado pendente continua bloqueado pelo guard server-side.

## Segurança e idempotência

- scheduler não depende do LLM;
- configuração é opt-in;
- organização/timezone são a fonte do relógio local;
- geração agendada é única por organização/data;
- outbox torna a solicitação de entrega durável;
- automation action torna preparação da mensagem idempotente;
- outbound message mantém idempotência do envio;
- geração manual preserva revisões anteriores;
- Agent não muda configuração sem pedido explícito.

## Smoke

A Feature 14 expande o smoke para 74 etapas e valida:

- configuração do schedule pelo Agent;
- geração agendada pelo worker;
- uma única geração por dia;
- `brief.delivery_requested` → n8n;
- outbound `daily_brief` enviado pelo provider mock;
- API de settings/today;
- leitura pelo Agent;
- revisão manual + idempotência;
- outbox completamente drenado.
