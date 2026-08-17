import type { DomainEvent } from './outbox.ts'
import type { Event } from './event.ts'

export const COMMAND_INTENTS = [
  'GET_EVENT_STATUS',
  'GET_OPEN_TASKS',
  'GET_PENDING_VENDORS',
  'CREATE_TASK',
  'COMPLETE_TASK',
  'ADD_EVENT_NOTE',
  'SET_CURRENT_EVENT',
  'SENSITIVE_CHANGE',
  'UNKNOWN',
] as const
export type CommandIntent = (typeof COMMAND_INTENTS)[number]

export const COMMAND_STATUSES = ['received','processing','processed','needs_review','rejected','failed'] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]
export type CommandInterpreterKind = 'rule_based' | 'ai' | 'agent'

export interface CommandEventOption {
  id: string
  name: string
  type: Event['type']
  startAt: Date
}

export interface CommandInterpreterInput {
  text: string
  now: Date
  timezone: string
  currentEventName: string | null
  availableEvents: CommandEventOption[]
}

export interface CommandInterpretation {
  intent: CommandIntent
  confidence: number
  eventReference: string | null
  taskReference: string | null
  taskTitle: string | null
  dueAt: string | null
  note: string | null
  sensitiveField: string | null
  sensitiveValue: string | null
  rationale: string | null
}

export interface CommandInterpreter {
  readonly kind: CommandInterpreterKind
  interpret(input: CommandInterpreterInput): Promise<CommandInterpretation>
}

export interface CommandRequest {
  id: string
  organizationId: string
  sender: string
  idempotencyKey: string
  rawText: string
  explicitEventId: string | null
  resolvedEventId: string | null
  interpreter: CommandInterpreterKind
  intent: CommandIntent | null
  confidence: number | null
  status: CommandStatus
  interpretation: CommandInterpretation | null
  result: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
  processedAt: Date | null
  lastError: string | null
}

export interface ConversationContext {
  id: string
  organizationId: string
  sender: string
  currentEventId: string | null
  lastInteractionAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface EventNote {
  id: string
  organizationId: string
  eventId: string
  sourceCommandRequestId: string
  body: string
  createdBySender: string
  source: 'command'
  createdAt: Date
}

export interface CreateCommandRequestInput {
  organizationId: string
  sender: string
  idempotencyKey: string
  rawText: string
  explicitEventId?: string | null
  interpreter: CommandInterpreterKind
  now: Date
  id: string
}

export interface UpdateCommandRequestInput {
  resolvedEventId?: string | null
  intent?: CommandIntent | null
  confidence?: number | null
  status?: CommandStatus
  interpretation?: CommandInterpretation | null
  result?: Record<string, unknown> | null
  processedAt?: Date | null
  lastError?: string | null
  updatedAt: Date
}

export interface CommandStore {
  createRequestIfAbsent(input: CreateCommandRequestInput): Promise<{ request: CommandRequest; created: boolean }>
  findRequestById(organizationId: string, requestId: string): Promise<CommandRequest | null>
  updateRequest(organizationId: string, requestId: string, input: UpdateCommandRequestInput): Promise<CommandRequest>
  getConversationContext(organizationId: string, sender: string): Promise<ConversationContext | null>
  setConversationContext(organizationId: string, sender: string, eventId: string | null, at: Date): Promise<ConversationContext>
  countOpenInbox(organizationId: string, eventId: string): Promise<number>
  findNoteByCommandRequestId(organizationId: string, commandRequestId: string): Promise<EventNote | null>
  createNoteWithOutbox(note: EventNote, domainEvent: DomainEvent): Promise<EventNote>
}

export class CommandValidationError extends Error {
  readonly code = 'COMMAND_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'CommandValidationError' }
}

export class CommandRequestNotFoundError extends Error {
  readonly code = 'COMMAND_REQUEST_NOT_FOUND'
  constructor(message = 'Command request not found') { super(message); this.name = 'CommandRequestNotFoundError' }
}

export class CommandInterpreterError extends Error {
  readonly code = 'COMMAND_INTERPRETER_ERROR'
  constructor(message: string) { super(message); this.name = 'CommandInterpreterError' }
}
