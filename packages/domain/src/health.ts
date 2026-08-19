import type { Event } from './event.ts'
import type { EventRisk, RiskSeverity, RiskType } from './risk.ts'
import type { DomainEvent, OutboxMessage } from './outbox.ts'

export const HEALTH_STATUSES = ['excellent','good','attention','critical'] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]

export const HEALTH_TRIGGER_TYPES = ['risk_evaluation','manual'] as const
export type HealthTriggerType = (typeof HEALTH_TRIGGER_TYPES)[number]

export const HEALTH_FACTOR_CATEGORIES = ['task','vendor','dependency','inbox','change'] as const
export type HealthFactorCategory = (typeof HEALTH_FACTOR_CATEGORIES)[number]

export interface HealthFactor {
  riskId: string
  riskType: RiskType
  severity: RiskSeverity
  category: HealthFactorCategory
  title: string
  riskScore: number
  penalty: number
}

export interface HealthBreakdown {
  baseScore: 100
  totalPenalty: number
  severityCeiling: number
  activeRiskCount: number
  acknowledgedRiskCount: number
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  categoryPenalties: Record<HealthFactorCategory, number>
  topFactors: HealthFactor[]
}

export interface EventHealthEvaluation {
  id: string
  organizationId: string
  eventId: string
  triggerType: HealthTriggerType
  triggerKey: string
  previousScore: number
  score: number
  delta: number
  status: HealthStatus
  breakdown: HealthBreakdown
  evaluatedAt: Date
}

export interface EventHealthCurrent {
  event: Event
  score: number
  status: HealthStatus
  breakdown: HealthBreakdown | null
  evaluatedAt: Date | null
  delta: number | null
}

export interface HealthSnapshot {
  event: Event
  activeRisks: EventRisk[]
  latestEvaluation: EventHealthEvaluation | null
}

export interface HealthEvaluationResult {
  evaluation: EventHealthEvaluation
  duplicate: boolean
  changed: boolean
}

export interface HealthStore {
  loadSnapshot(organizationId: string, eventId: string): Promise<HealthSnapshot | null>
  reconcileEvaluation(evaluation: EventHealthEvaluation, domainEvent: DomainEvent | null): Promise<HealthEvaluationResult>
  findLatest(organizationId: string, eventId: string): Promise<EventHealthEvaluation | null>
  listHistory(organizationId: string, eventId: string, limit?: number): Promise<EventHealthEvaluation[]>
  listCurrent(organizationId: string, limit?: number): Promise<EventHealthCurrent[]>
}

export class HealthValidationError extends Error {
  readonly code = 'HEALTH_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'HealthValidationError' }
}
export class HealthNotFoundError extends Error {
  readonly code = 'HEALTH_NOT_FOUND'
  constructor(message = 'Event not found for health evaluation') { super(message); this.name = 'HealthNotFoundError' }
}

export function healthStatusForScore(score: number): HealthStatus {
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 55) return 'attention'
  return 'critical'
}
