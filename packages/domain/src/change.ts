import type { DomainEvent } from './outbox.ts'
import type { Event } from './event.ts'

export const CHANGE_PROPOSAL_TYPES = ['event_date','event_time','guest_count','venue'] as const
export type ChangeProposalType = (typeof CHANGE_PROPOSAL_TYPES)[number]

export const CHANGE_PROPOSAL_STATUSES = ['proposed','applied','rejected','cancelled'] as const
export type ChangeProposalStatus = (typeof CHANGE_PROPOSAL_STATUSES)[number]

export const CHANGE_IMPACT_SEVERITIES = ['info','warning','critical'] as const
export type ChangeImpactSeverity = (typeof CHANGE_IMPACT_SEVERITIES)[number]

export const CHANGE_IMPACT_CATEGORIES = ['schedule','vendor','task','milestone','guest','venue','logistics'] as const
export type ChangeImpactCategory = (typeof CHANGE_IMPACT_CATEGORIES)[number]

export interface ChangeProposal {
  id: string
  organizationId: string
  eventId: string
  requestedBySender: string
  decidedBySender: string | null
  sourceAgentTurnId: string | null
  idempotencyKey: string
  type: ChangeProposalType
  currentValue: Record<string, unknown>
  proposedValue: Record<string, unknown>
  reason: string | null
  status: ChangeProposalStatus
  createdAt: Date
  updatedAt: Date
  decidedAt: Date | null
  appliedAt: Date | null
}

export interface ChangeProposalImpact {
  id: string
  organizationId: string
  proposalId: string
  eventId: string
  category: ChangeImpactCategory
  severity: ChangeImpactSeverity
  title: string
  description: string
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface ChangeProposalWithImpacts {
  proposal: ChangeProposal
  impacts: ChangeProposalImpact[]
}

export interface CreateChangeProposalInput {
  organizationId: string
  organizationTimezone: string
  eventId: string
  requestedBySender: string
  sourceAgentTurnId?: string | null
  idempotencyKey: string
  type: ChangeProposalType
  proposedValue: Record<string, unknown>
  reason?: string | null
}

export interface ListChangeProposalsInput {
  organizationId: string
  eventId?: string
  status?: ChangeProposalStatus
  requestedBySender?: string
  limit?: number
}

export interface ChangeProposalStore {
  findById(organizationId: string, proposalId: string): Promise<ChangeProposalWithImpacts | null>
  findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<ChangeProposalWithImpacts | null>
  list(input: ListChangeProposalsInput): Promise<ChangeProposalWithImpacts[]>
  createWithOutbox(
    proposal: ChangeProposal,
    impacts: ChangeProposalImpact[],
    domainEvent: DomainEvent,
  ): Promise<{ value: ChangeProposalWithImpacts; created: boolean }>
  applyWithOutbox(
    proposal: ChangeProposal,
    updatedEvent: Event,
    domainEvents: DomainEvent[],
  ): Promise<{ value: ChangeProposalWithImpacts; applied: boolean }>
  rejectWithOutbox(
    proposal: ChangeProposal,
    domainEvent: DomainEvent,
  ): Promise<{ value: ChangeProposalWithImpacts; rejected: boolean }>
}

export class ChangeProposalValidationError extends Error {
  readonly code = 'CHANGE_PROPOSAL_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'ChangeProposalValidationError' }
}

export class ChangeProposalNotFoundError extends Error {
  readonly code = 'CHANGE_PROPOSAL_NOT_FOUND'
  constructor(message = 'Change proposal not found') { super(message); this.name = 'ChangeProposalNotFoundError' }
}

export class ChangeProposalConflictError extends Error {
  readonly code = 'CHANGE_PROPOSAL_CONFLICT'
  constructor(message: string) { super(message); this.name = 'ChangeProposalConflictError' }
}
