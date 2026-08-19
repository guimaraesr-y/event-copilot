import type { Event } from './event.ts'
import type { EventTask } from './task.ts'
import type { EventVendor } from './vendor.ts'
import type { DependencyImpact } from './dependency.ts'
import type { InboxItem } from './operations.ts'
import type { DomainEvent } from './outbox.ts'

export const RISK_TYPES = [
  'task_overdue',
  'task_due_soon',
  'vendor_unconfirmed',
  'vendor_declined',
  'vendor_schedule_review',
  'dependency_unresolved',
  'critical_inbox_item',
  'recent_sensitive_change',
  'change_dependency_pending',
] as const
export type RiskType = (typeof RISK_TYPES)[number]

export const RISK_SEVERITIES = ['low','medium','high','critical'] as const
export type RiskSeverity = (typeof RISK_SEVERITIES)[number]

export const RISK_STATUSES = ['open','acknowledged','resolved'] as const
export type RiskStatus = (typeof RISK_STATUSES)[number]

export const RISK_SOURCE_TYPES = ['event','task','event_vendor','dependency_impact','inbox_item','change_proposal'] as const
export type RiskSourceType = (typeof RISK_SOURCE_TYPES)[number]

export const RISK_TRIGGER_TYPES = ['domain_event','scheduled','manual'] as const
export type RiskTriggerType = (typeof RISK_TRIGGER_TYPES)[number]

export interface EventRisk {
  id: string
  organizationId: string
  eventId: string
  riskKey: string
  type: RiskType
  severity: RiskSeverity
  score: number
  status: RiskStatus
  sourceType: RiskSourceType
  sourceId: string | null
  title: string
  description: string
  metadata: Record<string, unknown>
  firstDetectedAt: Date
  lastDetectedAt: Date
  acknowledgedAt: Date | null
  acknowledgedBy: string | null
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface RiskEvaluation {
  id: string
  organizationId: string
  eventId: string
  triggerType: RiskTriggerType
  triggerKey: string
  evaluatedAt: Date
}

export interface RiskCandidate {
  id: string
  organizationId: string
  eventId: string
  riskKey: string
  type: RiskType
  severity: RiskSeverity
  score: number
  sourceType: RiskSourceType
  sourceId: string | null
  title: string
  description: string
  metadata: Record<string, unknown>
}

export interface RiskAppliedChangeSnapshot {
  id: string
  type: 'event_date' | 'event_time' | 'guest_count' | 'venue'
  appliedAt: Date
  currentValue: Record<string, unknown>
  proposedValue: Record<string, unknown>
}

export interface RiskSnapshot {
  event: Event
  tasks: EventTask[]
  vendors: EventVendor[]
  dependencies: DependencyImpact[]
  inbox: InboxItem[]
  appliedChanges: RiskAppliedChangeSnapshot[]
}

export interface RiskReconciliationResult {
  risks: EventRisk[]
  detected: number
  updated: number
  resolved: number
  duplicate: boolean
}

export interface ListRisksInput {
  organizationId: string
  eventId?: string
  status?: RiskStatus
  severity?: RiskSeverity
  type?: RiskType
  minScore?: number
  limit?: number
}

export interface ActiveEventRef {
  organizationId: string
  eventId: string
}

export interface RiskStore {
  loadSnapshot(organizationId: string, eventId: string): Promise<RiskSnapshot | null>
  listActiveEventRefs(): Promise<ActiveEventRef[]>
  findById(organizationId: string, riskId: string): Promise<EventRisk | null>
  list(input: ListRisksInput): Promise<EventRisk[]>
  listActive(organizationId: string, limit?: number): Promise<EventRisk[]>
  reconcileEvaluation(evaluation: RiskEvaluation, candidates: RiskCandidate[]): Promise<RiskReconciliationResult>
  acknowledge(risk: EventRisk, sender: string, domainEvent: DomainEvent): Promise<{ risk: EventRisk; acknowledged: boolean }>
}

export class RiskValidationError extends Error {
  readonly code = 'RISK_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'RiskValidationError' }
}
export class RiskNotFoundError extends Error {
  readonly code = 'RISK_NOT_FOUND'
  constructor(message = 'Risk not found') { super(message); this.name = 'RiskNotFoundError' }
}
export class RiskConflictError extends Error {
  readonly code = 'RISK_CONFLICT'
  constructor(message: string) { super(message); this.name = 'RiskConflictError' }
}
