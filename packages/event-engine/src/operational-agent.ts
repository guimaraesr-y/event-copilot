import type {
  ActivityEntry,
  AgentToolTraceEntry,
  AgentTurn,
  AgentTurnStore,
  CommandInterpretation,
  Event,
  InboxItem,
} from '@ecc/domain'
import {
  OperationalAgentConflictError,
  OperationalAgentLoopError,
  OperationalAgentValidationError,
} from '@ecc/domain'
import type { EventEngine } from './event-engine.ts'
import type { VendorEngine } from './vendor-engine.ts'
import type { CommandEngine } from './command-engine.ts'
import type {
  AgentProviderMessage,
  AgentToolCall,
  AgentToolDefinition,
  OperationalAgentProvider,
} from './operational-agent-provider.ts'

export interface OperationalAgentOperationsReader {
  listActivity(input: { organizationId: string; eventId: string; category?: ActivityEntry['category']; limit?: number }): Promise<ActivityEntry[]>
  listInbox(input: { organizationId: string; status?: InboxItem['status']; severity?: InboxItem['severity']; eventId?: string; limit?: number }): Promise<InboxItem[]>
}

export interface OperationalAgentDependencies {
  store: AgentTurnStore
  provider: OperationalAgentProvider
  eventEngine: EventEngine
  vendorEngine: VendorEngine
  commandEngine: CommandEngine
  operations: OperationalAgentOperationsReader
  now?: () => Date
  newId?: () => string
  maxModelCalls?: number
  maxToolCalls?: number
  historyTurns?: number
}

export interface OperationalAgentInput {
  organizationId: string
  organizationTimezone: string
  sender: string
  text: string
  idempotencyKey: string
  explicitEventId?: string | null
}

export interface OperationalAgentResult {
  turn: AgentTurn
  duplicate: boolean
  reply: string
}

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'get_workspace_overview',
    description: 'Get a compact operational overview of all active events in the tenant, with task, vendor and inbox counts. Use for questions comparing or summarizing multiple events.',
    parameters: emptyObjectSchema(),
  },
  {
    name: 'get_event_details',
    description: 'Get detailed operational state for one event: dates, venue, guests, milestones, open tasks, vendors and open inbox items.',
    parameters: objectSchema({ eventId: stringSchema('Exact event UUID from the provided event catalog.') }, ['eventId']),
  },
  {
    name: 'get_event_activity',
    description: 'Get the recent business activity timeline for one event. Use for questions such as what happened, what changed or whether a supplier responded.',
    parameters: objectSchema({
      eventId: stringSchema('Exact event UUID from the event catalog.'),
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum activity entries. Default 10.' },
    }, ['eventId']),
  },
  {
    name: 'get_inbox',
    description: 'Get operational inbox items requiring attention. eventId is optional; omit it to inspect the tenant-wide inbox.',
    parameters: objectSchema({
      eventId: nullableStringSchema('Optional exact event UUID.'),
      severity: { type: ['string','null'], enum: ['info','warning','critical',null] },
      status: { type: ['string','null'], enum: ['open','in_progress','resolved','dismissed',null] },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    }),
  },
  {
    name: 'select_event',
    description: 'Set the current event context for the conversation. This is safe and does not modify event business data.',
    parameters: objectSchema({ eventId: stringSchema('Exact event UUID from the event catalog.') }, ['eventId']),
  },
  {
    name: 'create_task',
    description: 'Create a task in an event. Only call when the user explicitly asked to create/add/schedule a task and supplied enough date/time information. dueAt must be RFC3339 with offset.',
    parameters: objectSchema({
      eventId: stringSchema('Exact event UUID from the event catalog.'),
      title: stringSchema('Concise task title without scheduling words.'),
      dueAt: stringSchema('RFC3339 due date/time including timezone offset.'),
    }, ['eventId','title','dueAt']),
  },
  {
    name: 'complete_task',
    description: 'Complete an existing task. Only call when the user explicitly asked to mark a task complete.',
    parameters: objectSchema({
      eventId: stringSchema('Exact event UUID from the event catalog.'),
      taskReference: stringSchema('Human-readable task title/reference supplied by the user.'),
    }, ['eventId','taskReference']),
  },
  {
    name: 'add_event_note',
    description: 'Add an operational note to an event. Only call when the user explicitly asked to record/save/remember information.',
    parameters: objectSchema({
      eventId: stringSchema('Exact event UUID from the event catalog.'),
      note: stringSchema('Useful information to persist, without invented details.'),
    }, ['eventId','note']),
  },
]

const WRITE_TOOLS = new Set(['select_event','create_task','complete_task','add_event_note'])

export class OperationalAgent {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly maxModelCalls: number
  private readonly maxToolCalls: number
  private readonly historyTurns: number

  constructor(private readonly deps: OperationalAgentDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.maxModelCalls = clamp(deps.maxModelCalls ?? 6, 1, 12)
    this.maxToolCalls = clamp(deps.maxToolCalls ?? 8, 1, 20)
    this.historyTurns = clamp(deps.historyTurns ?? 6, 0, 12)
  }

  async chat(input: OperationalAgentInput): Promise<OperationalAgentResult> {
    const sender = input.sender.trim()
    const text = input.text.trim()
    const key = input.idempotencyKey.trim()
    if (sender.length < 2) throw new OperationalAgentValidationError('sender must contain at least 2 characters')
    if (text.length < 2) throw new OperationalAgentValidationError('text must contain at least 2 characters')
    if (key.length < 4) throw new OperationalAgentValidationError('idempotencyKey must contain at least 4 characters')

    const startedAt = this.now()
    const { turn: initial, created } = await this.deps.store.createTurnIfAbsent({
      id: this.newId(),
      organizationId: input.organizationId,
      sender,
      idempotencyKey: key,
      userText: text,
      explicitEventId: input.explicitEventId ?? null,
      provider: this.deps.provider.kind,
      model: this.deps.provider.model,
      now: startedAt,
    })

    if (!created) {
      const samePayload = initial.sender === sender && initial.userText === text && initial.explicitEventId === (input.explicitEventId ?? null)
      if (!samePayload) throw new OperationalAgentConflictError('idempotencyKey was already used for a different agent message')
      if (initial.status === 'completed' && initial.assistantText) {
        return { turn: initial, duplicate: true, reply: initial.assistantText }
      }
      // Never automatically replay an incomplete turn. A previous model/tool call may already
      // have produced a side effect even if the HTTP request failed afterwards. Retrying with
      // the same key would risk executing a logically identical write under a new tool index.
      throw new OperationalAgentConflictError(`Agent turn already exists with status ${initial.status}; use a new idempotencyKey after reviewing the previous turn`)
    }

    let modelCalls = initial.modelCalls
    const trace: AgentToolTraceEntry[] = [...initial.toolTrace]
    try {
      await this.deps.store.updateTurn(input.organizationId, initial.id, {
        status: 'processing', updatedAt: this.now(), lastError: null,
      })

      const events = await this.deps.eventEngine.listEvents(input.organizationId)
      if (input.explicitEventId) {
        const explicit = events.find((event) => event.id === input.explicitEventId)
        if (!explicit) throw new OperationalAgentValidationError('explicitEventId does not belong to this organization')
        await this.executeStructuredToolCommand(input, initial.id, trace.length, explicit, 'SET_CURRENT_EVENT', {
          eventReference: explicit.name,
        })
      }
      const conversation = await this.deps.commandEngine.getContext(input.organizationId, sender)
      const currentEvent = conversation?.currentEventId ? events.find((event) => event.id === conversation.currentEventId) ?? null : null
      const history = this.historyTurns > 0 ? await this.deps.store.listRecentTurns(input.organizationId, sender, this.historyTurns) : []

      const messages: AgentProviderMessage[] = [
        { role: 'system', content: buildSystemPrompt(input.organizationTimezone, startedAt) },
        { role: 'system', content: buildRuntimeContext(events, currentEvent) },
        ...history.flatMap((turn): AgentProviderMessage[] => turn.assistantText ? [
          { role: 'user', content: turn.userText },
          { role: 'assistant', content: turn.assistantText },
        ] : []),
        { role: 'user', content: text },
      ]

      let totalToolCalls = trace.length
      for (let loop = 0; loop < this.maxModelCalls; loop += 1) {
        modelCalls += 1
        const response = await this.deps.provider.complete({ messages, tools: TOOLS })
        messages.push(response.message)

        if (!response.toolCalls.length) {
          const reply = response.message.content.trim()
          if (!reply) throw new OperationalAgentLoopError('Agent returned neither a tool call nor a final answer')
          const completedAt = this.now()
          const turn = await this.deps.store.updateTurn(input.organizationId, initial.id, {
            assistantText: reply,
            status: 'completed',
            modelCalls,
            toolTrace: trace,
            completedAt,
            updatedAt: completedAt,
            lastError: null,
          })
          return { turn, duplicate: false, reply }
        }

        const batchResults: Array<{ call: AgentToolCall; result: Record<string, unknown> }> = []
        for (const call of response.toolCalls) {
          totalToolCalls += 1
          if (totalToolCalls > this.maxToolCalls) throw new OperationalAgentLoopError(`Agent exceeded max tool calls (${this.maxToolCalls})`)
          const result = await this.executeTool(input, initial.id, totalToolCalls, events, call)
          trace.push({ index: totalToolCalls, name: call.name, arguments: call.arguments, result })
          batchResults.push({ call, result })
          messages.push({ role: 'tool', toolName: call.name, content: JSON.stringify(result) })
        }

        // A successful write already returns a domain-owned human reply through CommandEngine.
        // Do not spend a second model inference merely to paraphrase the side effect. Read tools
        // still loop back to the model because their result requires conversational synthesis.
        if (batchResults.length > 0 && batchResults.every(({ call }) => WRITE_TOOLS.has(call.name))) {
          const reply = commandToolReply(batchResults[batchResults.length - 1]!.result)
          if (reply) {
            const completedAt = this.now()
            const turn = await this.deps.store.updateTurn(input.organizationId, initial.id, {
              assistantText: reply, status: 'completed', modelCalls, toolTrace: trace, completedAt, updatedAt: completedAt, lastError: null,
            })
            return { turn, duplicate: false, reply }
          }
        }
      }
      throw new OperationalAgentLoopError(`Agent exceeded max model calls (${this.maxModelCalls})`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failedAt = this.now()
      await this.deps.store.updateTurn(input.organizationId, initial.id, {
        status: 'failed', modelCalls, toolTrace: trace, completedAt: failedAt,
        updatedAt: failedAt, lastError: reason,
      }).catch(() => undefined)
      throw error
    }
  }

  async history(organizationId: string, sender: string, limit = 10): Promise<AgentTurn[]> {
    return this.deps.store.listRecentTurns(organizationId, sender, clamp(limit, 1, 20))
  }

  private async executeTool(
    input: OperationalAgentInput,
    turnId: string,
    toolIndex: number,
    events: Event[],
    call: AgentToolCall,
  ): Promise<Record<string, unknown>> {
    switch (call.name) {
      case 'get_workspace_overview': {
        assertNoUnexpectedKeys(call.arguments, [])
        const active = events.filter((event) => !['completed','cancelled'].includes(event.status)).slice(0, 20)
        const summaries = await Promise.all(active.map(async (event) => {
          const [tasks, vendors, inbox] = await Promise.all([
            this.deps.eventEngine.listTasks(input.organizationId, event.id),
            this.deps.vendorEngine.listEventVendors(input.organizationId, event.id),
            this.deps.operations.listInbox({ organizationId: input.organizationId, eventId: event.id, status: 'open', limit: 30 }),
          ])
          const openTasks = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length
          const confirmed = vendors.filter((vendor) => vendor.confirmationStatus === 'confirmed').length
          const vendorPending = vendors.filter((vendor) => vendor.confirmationStatus === 'pending' || vendor.confirmationStatus === 'requested').length
          return {
            id: event.id, name: event.name, type: event.type, startAt: event.startAt.toISOString(), status: event.status,
            healthScore: event.healthScore, openTasks, vendors: { total: vendors.length, confirmed, pending: vendorPending }, inboxOpen: inbox.length,
          }
        }))
        return { events: summaries, count: summaries.length }
      }
      case 'get_event_details': {
        assertNoUnexpectedKeys(call.arguments, ['eventId'])
        const event = requireEvent(events, requiredString(call.arguments, 'eventId'))
        const [tasks, vendors, milestones, inbox] = await Promise.all([
          this.deps.eventEngine.listTasks(input.organizationId, event.id),
          this.deps.vendorEngine.listEventVendors(input.organizationId, event.id),
          this.deps.eventEngine.listMilestones(input.organizationId, event.id),
          this.deps.operations.listInbox({ organizationId: input.organizationId, eventId: event.id, status: 'open', limit: 20 }),
        ])
        return {
          event: serializeEvent(event),
          milestones: milestones.slice(0, 20).map((item) => ({ id: item.id, name: item.name, status: item.status, dueAt: item.dueAt.toISOString() })),
          openTasks: tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').slice(0, 30).map((task) => ({ id: task.id, title: task.title, status: task.status, dueAt: task.dueAt.toISOString(), priority: task.priority })),
          vendors: vendors.slice(0, 40).map((vendor) => ({ id: vendor.id, name: vendor.vendorName, category: vendor.category, confirmationStatus: vendor.confirmationStatus, arrivalAt: vendor.arrivalAt?.toISOString() ?? null, teamSize: vendor.teamSize })),
          inbox: inbox.map(serializeInbox),
        }
      }
      case 'get_event_activity': {
        assertNoUnexpectedKeys(call.arguments, ['eventId','limit'])
        const event = requireEvent(events, requiredString(call.arguments, 'eventId'))
        const limit = optionalInteger(call.arguments, 'limit', 10, 1, 30)
        const activity = await this.deps.operations.listActivity({ organizationId: input.organizationId, eventId: event.id, limit })
        return { event: { id: event.id, name: event.name }, activity: activity.map((item) => ({ action: item.action, title: item.title, description: item.description, occurredAt: item.occurredAt.toISOString(), metadata: item.metadata })) }
      }
      case 'get_inbox': {
        assertNoUnexpectedKeys(call.arguments, ['eventId','severity','status','limit'])
        const eventId = optionalNullableString(call.arguments, 'eventId')
        if (eventId) requireEvent(events, eventId)
        const severity = optionalEnum(call.arguments, 'severity', ['info','warning','critical'] as const)
        const status = optionalEnum(call.arguments, 'status', ['open','in_progress','resolved','dismissed'] as const) ?? 'open'
        const limit = optionalInteger(call.arguments, 'limit', 20, 1, 30)
        const inbox = await this.deps.operations.listInbox({
          organizationId: input.organizationId, status, limit,
          ...(eventId ? { eventId } : {}), ...(severity ? { severity } : {}),
        })
        return { inbox: inbox.map(serializeInbox), count: inbox.length }
      }
      case 'select_event': {
        assertNoUnexpectedKeys(call.arguments, ['eventId'])
        const event = requireEvent(events, requiredString(call.arguments, 'eventId'))
        const command = await this.executeStructuredToolCommand(input, turnId, toolIndex, event, 'SET_CURRENT_EVENT', { eventReference: event.name })
        return command
      }
      case 'create_task': {
        assertNoUnexpectedKeys(call.arguments, ['eventId','title','dueAt'])
        const event = requireEvent(events, requiredString(call.arguments, 'eventId'))
        const title = requiredString(call.arguments, 'title')
        const dueAt = requiredRfc3339(call.arguments, 'dueAt')
        return this.executeStructuredToolCommand(input, turnId, toolIndex, event, 'CREATE_TASK', { taskTitle: title, dueAt })
      }
      case 'complete_task': {
        assertNoUnexpectedKeys(call.arguments, ['eventId','taskReference'])
        const event = requireEvent(events, requiredString(call.arguments, 'eventId'))
        const taskReference = requiredString(call.arguments, 'taskReference')
        return this.executeStructuredToolCommand(input, turnId, toolIndex, event, 'COMPLETE_TASK', { taskReference })
      }
      case 'add_event_note': {
        assertNoUnexpectedKeys(call.arguments, ['eventId','note'])
        const event = requireEvent(events, requiredString(call.arguments, 'eventId'))
        const note = requiredString(call.arguments, 'note')
        return this.executeStructuredToolCommand(input, turnId, toolIndex, event, 'ADD_EVENT_NOTE', { note })
      }
      default:
        throw new OperationalAgentValidationError(`Unknown operational agent tool: ${call.name}`)
    }
  }

  private async executeStructuredToolCommand(
    input: OperationalAgentInput,
    turnId: string,
    toolIndex: number,
    event: Event,
    intent: CommandInterpretation['intent'],
    fields: Partial<CommandInterpretation>,
  ): Promise<Record<string, unknown>> {
    if (!['SET_CURRENT_EVENT','CREATE_TASK','COMPLETE_TASK','ADD_EVENT_NOTE'].includes(intent)) {
      throw new OperationalAgentValidationError(`Operational Agent cannot execute structured intent ${intent}`)
    }
    const interpretation: CommandInterpretation = {
      intent,
      confidence: 1,
      eventReference: event.name,
      taskReference: null,
      taskTitle: null,
      dueAt: null,
      note: null,
      sensitiveField: null,
      sensitiveValue: null,
      rationale: 'operational_agent_tool',
      ...fields,
    }
    const execution = await this.deps.commandEngine.executeStructured({
      organizationId: input.organizationId,
      organizationTimezone: input.organizationTimezone,
      sender: input.sender,
      text: input.text,
      idempotencyKey: `agent:${turnId}:${toolIndex}:${intent}`,
      explicitEventId: event.id,
    }, interpretation)
    return {
      commandRequestId: execution.request.id,
      status: execution.request.status,
      duplicate: execution.duplicate,
      result: execution.result,
    }
  }
}

function commandToolReply(result: Record<string, unknown>): string | null {
  const nested = result.result
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return null
  const reply = (nested as Record<string, unknown>).reply
  return typeof reply === 'string' && reply.trim() ? reply.trim() : null
}

function buildSystemPrompt(timezone: string, now: Date): string {
  const localNow = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(now)
  return `Você é o Operational Agent do Event Command Center, copiloto de um cerimonialista.\n\nCONTEXTO TEMPORAL\n- timezone da organização: ${timezone}\n- agora: ${localNow}\n- agora em ISO UTC: ${now.toISOString()}\n\nREGRAS\n1. Converse naturalmente em português brasileiro e mantenha contexto entre mensagens.\n2. Você pode raciocinar sobre vários eventos do tenant. Use as ferramentas para obter fatos atuais; nunca invente estado operacional.\n3. Para comparar ou resumir vários eventos, prefira get_workspace_overview. Para um evento específico, prefira get_event_details.\n4. Só execute ferramentas de escrita quando o usuário pedir explicitamente a alteração. Nunca transforme uma sugestão sua em ação automática.\n5. As únicas escritas permitidas são select_event, create_task, complete_task e add_event_note. Elas passam pelo CommandEngine e regras de domínio.\n6. Alterar data, horário, quantidade de convidados, local/endereço do evento é sensível. NÃO existe ferramenta para isso nesta versão. Explique que exige Change Proposal e não afirme que alterou.\n7. Se faltarem dados necessários para escrever (por exemplo prazo da tarefa), faça uma pergunta curta em vez de adivinhar.\n8. UUIDs são detalhes internos. Não exponha IDs ao usuário na resposta final salvo se ele pedir.\n9. Se uma ferramenta retornar not found, ambiguidade, needs_review ou erro, explique e peça somente o dado necessário.\n10. Depois de uma escrita bem-sucedida, confirme exatamente o que foi alterado.\n11. Seja objetivo: normalmente 1 a 5 frases, salvo quando o usuário pedir análise detalhada.`
}

function buildRuntimeContext(events: Event[], current: Event | null): string {
  const catalog = events.slice(0, 50).map((event) => ({ id: event.id, name: event.name, type: event.type, startAt: event.startAt.toISOString(), status: event.status }))
  return `CATÁLOGO DE EVENTOS DO TENANT\n${JSON.stringify(catalog)}\n\nEVENTO ATUAL DA CONVERSA\n${current ? JSON.stringify({ id: current.id, name: current.name }) : 'nenhum'}\n\nUse somente eventId existente nesse catálogo ao chamar ferramentas.`
}

function requireEvent(events: Event[], eventId: string): Event {
  const event = events.find((candidate) => candidate.id === eventId)
  if (!event) throw new OperationalAgentValidationError('Tool eventId does not belong to this organization')
  return event
}
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length < 1) throw new OperationalAgentValidationError(`Tool argument ${key} must be a non-empty string`)
  return value.trim()
}
function requiredRfc3339(args: Record<string, unknown>, key: string): string {
  const value = requiredString(args, key)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new OperationalAgentValidationError(`Tool argument ${key} must be a valid RFC3339 datetime with timezone`)
  }
  return value
}
function optionalNullableString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new OperationalAgentValidationError(`Tool argument ${key} must be a string or null`)
  return value.trim() || null
}
function optionalInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new OperationalAgentValidationError(`Tool argument ${key} must be an integer between ${min} and ${max}`)
  return value as number
}
function optionalEnum<T extends readonly string[]>(args: Record<string, unknown>, key: string, allowed: T): T[number] | null {
  const value = args[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !allowed.includes(value)) throw new OperationalAgentValidationError(`Tool argument ${key} has an unsupported value`)
  return value as T[number]
}
function assertNoUnexpectedKeys(args: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length) throw new OperationalAgentValidationError(`Unexpected tool argument(s): ${unexpected.join(', ')}`)
}
function serializeEvent(event: Event) {
  return { id: event.id, name: event.name, type: event.type, startAt: event.startAt.toISOString(), endAt: event.endAt?.toISOString() ?? null, status: event.status, venueName: event.venueName, venueAddress: event.venueAddress, guestCount: event.guestCount, healthScore: event.healthScore }
}
function serializeInbox(item: InboxItem) {
  return { id: item.id, eventId: item.eventId, type: item.type, severity: item.severity, title: item.title, description: item.description, status: item.status, createdAt: item.createdAt.toISOString(), metadata: item.metadata }
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))) }
function stringSchema(description: string): Record<string, unknown> { return { type: 'string', minLength: 1, description } }
function nullableStringSchema(description: string): Record<string, unknown> { return { type: ['string','null'], description } }
function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> { return { type: 'object', additionalProperties: false, properties, required } }
function emptyObjectSchema(): Record<string, unknown> { return objectSchema({}) }
