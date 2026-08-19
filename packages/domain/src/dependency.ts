import type { DomainEvent, OutboxMessage } from './outbox.ts'

export const DEPENDENCY_TYPES = [
  'task_due_date',
  'milestone_due_date',
  'vendor_schedule',
  'vendor_reconfirmation',
  'guest_capacity_review',
  'venue_logistics_review',
  'manual_schedule_review',
] as const
export type DependencyType = (typeof DEPENDENCY_TYPES)[number]

export const DEPENDENCY_ACTIONS = ['suggest_update','review'] as const
export type DependencyAction = (typeof DEPENDENCY_ACTIONS)[number]

export const DEPENDENCY_STATUSES = ['open','applied','resolved','dismissed'] as const
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number]

export const DEPENDENCY_ENTITY_TYPES = ['task','milestone','event_vendor','event'] as const
export type DependencyEntityType = (typeof DEPENDENCY_ENTITY_TYPES)[number]

export const DEPENDENCY_SEVERITIES = ['info','warning','critical'] as const
export type DependencySeverity = (typeof DEPENDENCY_SEVERITIES)[number]


export interface DependencyEvaluation {
  id: string
  organizationId: string
  eventId: string
  proposalId: string
  sourceChangeEventId: string
  changeType: 'event_date' | 'event_time' | 'guest_count' | 'venue'
  impactCount: number
  createdAt: Date
}

export interface DependencyImpact {
  id: string
  organizationId: string
  eventId: string
  proposalId: string
  sourceChangeEventId: string
  ruleKey: string
  dependencyType: DependencyType
  entityType: DependencyEntityType
  entityId: string
  action: DependencyAction
  severity: DependencySeverity
  status: DependencyStatus
  title: string
  description: string
  currentValue: Record<string, unknown>
  suggestedValue: Record<string, unknown> | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

export interface ListDependencyImpactsInput {
  organizationId: string
  eventId?: string
  proposalId?: string
  status?: DependencyStatus
  action?: DependencyAction
  dependencyType?: DependencyType
  limit?: number
}

export type DependencyEntityUpdate =
  | { entityType: 'task'; entityId: string; dueAt: Date }
  | { entityType: 'milestone'; entityId: string; dueAt: Date }
  | { entityType: 'event_vendor'; entityId: string; arrivalAt: Date | null; departureAt: Date | null }

export interface DependencyStore {
  findById(organizationId: string, impactId: string): Promise<DependencyImpact | null>
  hasEvaluation(organizationId: string, sourceChangeEventId: string): Promise<boolean>
  list(input: ListDependencyImpactsInput): Promise<DependencyImpact[]>
  findBySourceChangeEvent(organizationId: string, sourceChangeEventId: string): Promise<DependencyImpact[]>
  createEvaluation(
    evaluation: DependencyEvaluation,
    impacts: DependencyImpact[],
    domainEvents: DomainEvent[],
  ): Promise<{ impacts: DependencyImpact[]; created: boolean }>
  applySuggestion(
    impact: DependencyImpact,
    update: DependencyEntityUpdate,
    domainEvent: DomainEvent,
  ): Promise<{ impact: DependencyImpact; applied: boolean }>
  resolveReview(
    impact: DependencyImpact,
    domainEvent: DomainEvent,
  ): Promise<{ impact: DependencyImpact; resolved: boolean }>
  dismiss(
    impact: DependencyImpact,
    domainEvent: DomainEvent,
  ): Promise<{ impact: DependencyImpact; dismissed: boolean }>
}

export interface AppliedChangeForDependencies {
  message: OutboxMessage
  organizationTimezone: string
}

export class DependencyValidationError extends Error {
  readonly code = 'DEPENDENCY_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'DependencyValidationError' }
}
export class DependencyNotFoundError extends Error {
  readonly code = 'DEPENDENCY_NOT_FOUND'
  constructor(message = 'Dependency impact not found') { super(message); this.name = 'DependencyNotFoundError' }
}
export class DependencyConflictError extends Error {
  readonly code = 'DEPENDENCY_CONFLICT'
  constructor(message: string) { super(message); this.name = 'DependencyConflictError' }
}
