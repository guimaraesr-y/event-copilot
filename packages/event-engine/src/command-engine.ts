import type {
  CommandInterpretation,
  CommandRequest,
  CommandStore,
  Event,
  EventNote,
  EventTask,
  EventVendor,
  CommandInterpreter,
  CommandInterpreterKind,
} from '@ecc/domain'
import { CommandRequestNotFoundError, CommandValidationError } from '@ecc/domain'
import type { EventEngine } from './event-engine.ts'
import type { VendorEngine } from './vendor-engine.ts'

export interface CommandEngineDependencies {
  store: CommandStore
  eventEngine: EventEngine
  vendorEngine: VendorEngine
  interpreter: CommandInterpreter
  now?: () => Date
  newId?: () => string
}

export interface ExecuteCommandInput {
  organizationId: string
  organizationTimezone: string
  sender: string
  text: string
  idempotencyKey: string
  explicitEventId?: string | null
}

export interface CommandExecutionResult {
  request: CommandRequest
  duplicate: boolean
  reply: string
  result: Record<string, unknown>
}

const TERMINAL = new Set(['processed','needs_review','rejected'] as const)

export class CommandEngine {
  private readonly now: () => Date
  private readonly newId: () => string
  constructor(private readonly deps: CommandEngineDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async execute(input: ExecuteCommandInput): Promise<CommandExecutionResult> {
    return this.executeWithInterpreter(input, this.deps.interpreter.kind, (context) => this.deps.interpreter.interpret(context))
  }

  /**
   * Executes an already-structured command through the exact same domain path used by
   * the conversational command interpreter. This is intentionally server-internal:
   * Operational Agent tools validate their arguments and delegate here instead of
   * letting the model call repositories or SQL directly.
   */
  async executeStructured(input: ExecuteCommandInput, interpretation: CommandInterpretation): Promise<CommandExecutionResult> {
    return this.executeWithInterpreter(input, 'agent', async () => interpretation)
  }

  private async executeWithInterpreter(
    input: ExecuteCommandInput,
    interpreterKind: CommandInterpreterKind,
    interpret: (context: Parameters<CommandInterpreter['interpret']>[0]) => Promise<CommandInterpretation>,
  ): Promise<CommandExecutionResult> {
    const sender = input.sender.trim()
    const text = input.text.trim()
    const key = input.idempotencyKey.trim()
    if (sender.length < 2) throw new CommandValidationError('sender must contain at least 2 characters')
    if (text.length < 2) throw new CommandValidationError('text must contain at least 2 characters')
    if (key.length < 4) throw new CommandValidationError('idempotencyKey must contain at least 4 characters')

    const now = this.now()
    const { request: initial, created } = await this.deps.store.createRequestIfAbsent({
      id: this.newId(), organizationId: input.organizationId, sender, idempotencyKey: key, rawText: text,
      explicitEventId: input.explicitEventId ?? null, interpreter: interpreterKind, now,
    })

    if (!created) {
      const samePayload = initial.sender === sender && initial.rawText === text && initial.explicitEventId === (input.explicitEventId ?? null)
      if (!samePayload) throw new CommandValidationError('idempotencyKey was already used for a different command payload')
      if (TERMINAL.has(initial.status as any) && initial.result) {
        return { request: initial, duplicate: true, reply: stringValue(initial.result.reply) ?? 'Comando já processado.', result: initial.result }
      }
    }

    try {
      await this.deps.store.updateRequest(input.organizationId, initial.id, { status: 'processing', updatedAt: now, lastError: null })
      const events = await this.deps.eventEngine.listEvents(input.organizationId)
      const context = await this.deps.store.getConversationContext(input.organizationId, sender)
      const current = context?.currentEventId ? events.find((event) => event.id === context.currentEventId) ?? null : null

      const interpretation = await interpret({
        text,
        now,
        timezone: input.organizationTimezone,
        currentEventName: current?.name ?? null,
        availableEvents: events.map((event) => ({ id: event.id, name: event.name, type: event.type, startAt: event.startAt })),
      })

      const resolved = resolveEvent(events, input.explicitEventId ?? null, interpretation.eventReference, current, interpretation.intent)
      await this.deps.store.updateRequest(input.organizationId, initial.id, {
        resolvedEventId: resolved.event?.id ?? null,
        intent: interpretation.intent,
        confidence: interpretation.confidence,
        interpretation,
        updatedAt: this.now(),
      })

      if (resolved.ambiguous) {
        return this.finish(initial.id, input.organizationId, 'needs_review', interpretation, resolved.event?.id ?? null, {
          reply: 'Encontrei mais de um evento compatível. Informe qual evento deseja usar.',
          reason: 'ambiguous_event',
          candidates: resolved.candidates.map((event) => ({ id: event.id, name: event.name })),
        }, false)
      }

      if (requiresEvent(interpretation.intent) && !resolved.event) {
        return this.finish(initial.id, input.organizationId, 'needs_review', interpretation, null, {
          reply: 'Não consegui identificar com segurança qual evento deve ser usado.', reason: 'event_context_required',
        }, false)
      }

      if (interpretation.intent === 'UNKNOWN') {
        return this.finish(initial.id, input.organizationId, 'needs_review', interpretation, resolved.event?.id ?? null, {
          reply: 'Não consegui entender esse comando com segurança.', reason: 'unknown_command',
        }, false)
      }

      if (interpretation.intent === 'SENSITIVE_CHANGE') {
        if (resolved.event) await this.deps.store.setConversationContext(input.organizationId, sender, resolved.event.id, this.now())
        return this.finish(initial.id, input.organizationId, 'rejected', interpretation, resolved.event?.id ?? null, {
          reply: 'Essa alteração é sensível e exige uma proposta de mudança antes de ser aplicada.',
          requiresChangeProposal: true,
          field: interpretation.sensitiveField,
          requestedValue: interpretation.sensitiveValue,
        }, false)
      }

      const event = resolved.event!
      let result: Record<string, unknown>

      switch (interpretation.intent) {
        case 'SET_CURRENT_EVENT':
          result = { reply: `Contexto alterado para ${event.name}.`, event: serializeEventRef(event) }
          break
        case 'GET_EVENT_STATUS':
          result = await this.eventStatus(input.organizationId, event)
          break
        case 'GET_OPEN_TASKS':
          result = await this.openTasks(input.organizationId, event)
          break
        case 'GET_PENDING_VENDORS':
          result = await this.pendingVendors(input.organizationId, event)
          break
        case 'CREATE_TASK':
          result = await this.createTask(input.organizationId, event, initial.id, interpretation, interpreterKind)
          break
        case 'COMPLETE_TASK':
          result = await this.completeTask(input.organizationId, event, text, interpretation)
          break
        case 'ADD_EVENT_NOTE':
          result = await this.addNote(input.organizationId, event, sender, initial.id, interpretation)
          break
        default:
          throw new CommandValidationError(`Unsupported command intent: ${interpretation.intent}`)
      }

      await this.deps.store.setConversationContext(input.organizationId, sender, event.id, this.now())
      return this.finish(initial.id, input.organizationId, 'processed', interpretation, event.id, result, false)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.deps.store.updateRequest(input.organizationId, initial.id, {
        status: 'failed', updatedAt: this.now(), processedAt: this.now(), lastError: reason,
        result: { reply: 'Não foi possível processar o comando.', error: reason },
      }).catch(() => undefined)
      throw error
    }
  }

  async findRequest(organizationId: string, requestId: string): Promise<CommandRequest> {
    const request = await this.deps.store.findRequestById(organizationId, requestId)
    if (!request) throw new CommandRequestNotFoundError()
    return request
  }

  async getContext(organizationId: string, sender: string) {
    return this.deps.store.getConversationContext(organizationId, sender)
  }

  private async eventStatus(organizationId: string, event: Event): Promise<Record<string, unknown>> {
    const tasks = await this.deps.eventEngine.listTasks(organizationId, event.id)
    const vendors = await this.deps.vendorEngine.listEventVendors(organizationId, event.id)
    const openTasks = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress')
    const confirmed = vendors.filter((vendor) => vendor.confirmationStatus === 'confirmed').length
    const pending = vendors.filter((vendor) => vendor.confirmationStatus === 'pending' || vendor.confirmationStatus === 'requested').length
    const inboxOpen = await this.deps.store.countOpenInbox(organizationId, event.id)
    const reply = `${event.name}: ${openTasks.length} tarefa(s) aberta(s), ${confirmed}/${vendors.length} fornecedor(es) confirmado(s), ${pending} aguardando confirmação e ${inboxOpen} item(ns) na inbox.`
    return { reply, event: serializeEventRef(event), openTasks: openTasks.length, vendors: { total: vendors.length, confirmed, pending }, inboxOpen }
  }

  private async openTasks(organizationId: string, event: Event): Promise<Record<string, unknown>> {
    const tasks = (await this.deps.eventEngine.listTasks(organizationId, event.id))
      .filter((task) => task.status === 'pending' || task.status === 'in_progress')
      .slice(0, 20)
    const reply = tasks.length ? `Tarefas abertas de ${event.name}: ${tasks.map((task) => task.title).join('; ')}.` : `${event.name} não possui tarefas abertas.`
    return { reply, event: serializeEventRef(event), tasks: tasks.map(serializeTaskRef) }
  }

  private async pendingVendors(organizationId: string, event: Event): Promise<Record<string, unknown>> {
    const vendors = (await this.deps.vendorEngine.listEventVendors(organizationId, event.id))
      .filter((vendor) => vendor.confirmationStatus === 'pending' || vendor.confirmationStatus === 'requested')
    const reply = vendors.length ? `Fornecedores aguardando confirmação em ${event.name}: ${vendors.map((vendor) => vendor.vendorName).join('; ')}.` : `Todos os fornecedores solicitados de ${event.name} estão resolvidos.`
    return { reply, event: serializeEventRef(event), vendors: vendors.map(serializeVendorRef) }
  }

  private async createTask(organizationId: string, event: Event, requestId: string, interpretation: CommandInterpretation, interpreterKind: CommandInterpreterKind): Promise<Record<string, unknown>> {
    const title = interpretation.taskTitle?.trim()
    if (!title) return { reply: 'Entendi que você quer criar uma tarefa, mas faltou o título.', needsReview: true, reason: 'task_title_required' }
    if (!interpretation.dueAt) return { reply: 'Entendi a tarefa, mas preciso de uma data ou prazo para criá-la.', needsReview: true, reason: 'task_due_at_required' }
    const dueAt = new Date(interpretation.dueAt)
    if (Number.isNaN(dueAt.getTime())) return { reply: 'Não consegui interpretar o prazo da tarefa.', needsReview: true, reason: 'invalid_task_due_at' }
    const task = await this.deps.eventEngine.createManualTask({
      organizationId, eventId: event.id, title, dueAt,
      source: interpreterKind === 'rule_based' ? 'automation' : 'ai',
      sourceCommandRequestId: requestId,
    })
    return { reply: `Tarefa criada em ${event.name}: ${task.title}.`, task: serializeTaskRef(task), event: serializeEventRef(event) }
  }

  private async completeTask(organizationId: string, event: Event, rawText: string, interpretation: CommandInterpretation): Promise<Record<string, unknown>> {
    const open = (await this.deps.eventEngine.listTasks(organizationId, event.id)).filter((task) => task.status !== 'cancelled')
    const matched = resolveNamedTask(open, interpretation.taskReference ?? rawText)
    if (matched.ambiguous) return { reply: 'Encontrei mais de uma tarefa compatível. Informe o nome da tarefa com mais detalhes.', needsReview: true, reason: 'ambiguous_task', candidates: matched.candidates.map(serializeTaskRef) }
    if (!matched.task) return { reply: 'Não encontrei uma tarefa compatível nesse evento.', needsReview: true, reason: 'task_not_found' }
    if (matched.task.status === 'completed') return { reply: `A tarefa ${matched.task.title} já estava concluída.`, task: serializeTaskRef(matched.task), event: serializeEventRef(event) }
    const task = await this.deps.eventEngine.updateTask({ organizationId, eventId: event.id, taskId: matched.task.id, status: 'completed' })
    return { reply: `Tarefa concluída: ${task.title}.`, task: serializeTaskRef(task), event: serializeEventRef(event) }
  }

  private async addNote(organizationId: string, event: Event, sender: string, requestId: string, interpretation: CommandInterpretation): Promise<Record<string, unknown>> {
    const body = interpretation.note?.trim()
    if (!body) return { reply: 'Entendi que você quer adicionar uma observação, mas faltou o conteúdo.', needsReview: true, reason: 'note_required' }
    const existing = await this.deps.store.findNoteByCommandRequestId(organizationId, requestId)
    const now = this.now()
    const note: EventNote = existing ?? {
      id: this.newId(), organizationId, eventId: event.id, sourceCommandRequestId: requestId,
      body, createdBySender: sender, source: 'command', createdAt: now,
    }
    const saved = existing ?? await this.deps.store.createNoteWithOutbox(note, {
      id: this.newId(), organizationId, eventType: 'event.note_added', aggregateType: 'event_note', aggregateId: note.id,
      occurredAt: now, payload: { eventId: event.id, noteId: note.id, text: note.body, sender, source: 'command' },
    })
    return { reply: `Observação adicionada a ${event.name}.`, note: { id: saved.id, body: saved.body }, event: serializeEventRef(event) }
  }

  private async finish(
    requestId: string,
    organizationId: string,
    status: 'processed' | 'needs_review' | 'rejected',
    interpretation: CommandInterpretation,
    resolvedEventId: string | null,
    result: Record<string, unknown>,
    duplicate: boolean,
  ): Promise<CommandExecutionResult> {
    const now = this.now()
    // Safe commands that lacked a required field must remain reviewable, not falsely "processed".
    const finalStatus = result.needsReview === true ? 'needs_review' : status
    const request = await this.deps.store.updateRequest(organizationId, requestId, {
      resolvedEventId, intent: interpretation.intent, confidence: interpretation.confidence,
      interpretation, status: finalStatus, result, processedAt: now, updatedAt: now, lastError: null,
    })
    return { request, duplicate, reply: stringValue(result.reply) ?? '', result }
  }
}

function requiresEvent(intent: CommandInterpretation['intent']): boolean {
  return !['UNKNOWN'].includes(intent)
}

function resolveEvent(
  events: Event[], explicitEventId: string | null, reference: string | null, current: Event | null,
  intent: CommandInterpretation['intent'],
): { event: Event | null; ambiguous: boolean; candidates: Event[] } {
  if (explicitEventId) return { event: events.find((event) => event.id === explicitEventId) ?? null, ambiguous: false, candidates: [] }
  if (reference) {
    const candidates = rankByName(events, reference)
    if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return { event: null, ambiguous: true, candidates: candidates.filter((c) => c.score === candidates[0]!.score).map((c) => c.value) }
    if (candidates[0]?.score && candidates[0].score > 0) return { event: candidates[0].value, ambiguous: false, candidates: [candidates[0].value] }
  }
  if (intent !== 'SET_CURRENT_EVENT' && current) return { event: current, ambiguous: false, candidates: [current] }
  const active = events.filter((event) => !['completed','cancelled'].includes(event.status))
  if (active.length === 1) return { event: active[0]!, ambiguous: false, candidates: active }
  return { event: null, ambiguous: active.length > 1, candidates: active }
}

function resolveNamedTask(tasks: EventTask[], reference: string): { task: EventTask | null; ambiguous: boolean; candidates: EventTask[] } {
  const ranked = rankByName(tasks, reference, (task) => task.title)
  if (!ranked[0] || ranked[0].score <= 0) return { task: null, ambiguous: false, candidates: [] }
  const ties = ranked.filter((candidate) => candidate.score === ranked[0]!.score).map((candidate) => candidate.value)
  return ties.length > 1 ? { task: null, ambiguous: true, candidates: ties } : { task: ranked[0].value, ambiguous: false, candidates: ties }
}

function rankByName<T>(values: T[], reference: string, nameOf: (value: T) => string = (value) => (value as Event).name) {
  const normalizedReference = normalize(reference)
  return values.map((value) => {
    const name = normalize(nameOf(value))
    if (normalizedReference.includes(name) || name.includes(normalizedReference)) return { value, score: 100 + Math.min(name.length, normalizedReference.length) }
    const tokens = name.split(/\s+/).filter((token) => token.length >= 3 && !STOP.has(token))
    const score = tokens.reduce((sum, token) => sum + (normalizedReference.includes(token) ? 10 : 0), 0)
    return { value, score }
  }).filter((candidate) => candidate.score > 0).sort((a,b) => b.score-a.score)
}
const STOP = new Set(['casamento','evento','festa','aniversario','de','da','do','dos','das','para','tarefa'])
function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9\s&-]/g,' ').replace(/\s+/g,' ').trim() }
function serializeEventRef(event: Event) { return { id: event.id, name: event.name, type: event.type, startAt: event.startAt.toISOString() } }
function serializeTaskRef(task: EventTask) { return { id: task.id, title: task.title, status: task.status, dueAt: task.dueAt.toISOString(), priority: task.priority, source: task.source } }
function serializeVendorRef(vendor: EventVendor) { return { id: vendor.id, vendorId: vendor.vendorId, name: vendor.vendorName, category: vendor.category, confirmationStatus: vendor.confirmationStatus } }
function stringValue(value: unknown): string | null { return typeof value === 'string' ? value : null }
