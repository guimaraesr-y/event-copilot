export const AGENT_TURN_STATUSES = ['received','processing','completed','failed'] as const
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number]
export type OperationalAgentProviderKind = 'ollama' | 'openai' | 'gemini' | 'deterministic'

export interface AgentToolTraceEntry {
  index: number
  name: string
  arguments: Record<string, unknown>
  result: Record<string, unknown>
}

export interface AgentTurn {
  id: string
  organizationId: string
  sender: string
  idempotencyKey: string
  userText: string
  explicitEventId: string | null
  assistantText: string | null
  status: AgentTurnStatus
  provider: OperationalAgentProviderKind
  model: string
  modelCalls: number
  toolTrace: AgentToolTraceEntry[]
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  lastError: string | null
}

export interface CreateAgentTurnInput {
  id: string
  organizationId: string
  sender: string
  idempotencyKey: string
  userText: string
  explicitEventId?: string | null
  provider: OperationalAgentProviderKind
  model: string
  now: Date
}

export interface UpdateAgentTurnInput {
  assistantText?: string | null
  status?: AgentTurnStatus
  modelCalls?: number
  toolTrace?: AgentToolTraceEntry[]
  completedAt?: Date | null
  lastError?: string | null
  updatedAt: Date
}

export interface AgentTurnStore {
  createTurnIfAbsent(input: CreateAgentTurnInput): Promise<{ turn: AgentTurn; created: boolean }>
  updateTurn(organizationId: string, turnId: string, input: UpdateAgentTurnInput): Promise<AgentTurn>
  listRecentTurns(organizationId: string, sender: string, limit: number): Promise<AgentTurn[]>
}

export class OperationalAgentValidationError extends Error {
  readonly code = 'OPERATIONAL_AGENT_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'OperationalAgentValidationError' }
}


export class OperationalAgentConflictError extends Error {
  readonly code = 'OPERATIONAL_AGENT_TURN_CONFLICT'
  constructor(message: string) { super(message); this.name = 'OperationalAgentConflictError' }
}

export class OperationalAgentProviderError extends Error {
  readonly code = 'OPERATIONAL_AGENT_PROVIDER_ERROR'
  constructor(message: string) { super(message); this.name = 'OperationalAgentProviderError' }
}

export class OperationalAgentLoopError extends Error {
  readonly code = 'OPERATIONAL_AGENT_LOOP_ERROR'
  constructor(message: string) { super(message); this.name = 'OperationalAgentLoopError' }
}
