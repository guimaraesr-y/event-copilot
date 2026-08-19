import type {
  EventHealthCurrent,
  EventHealthEvaluation,
  EventRisk,
  HealthBreakdown,
  HealthEvaluationResult,
  HealthFactor,
  HealthFactorCategory,
  HealthSnapshot,
  HealthStore,
  OutboxMessage,
  RiskType,
} from '@ecc/domain'
import { HealthNotFoundError, HealthValidationError, healthStatusForScore } from '@ecc/domain'

export interface HealthEngineDependencies {
  store: HealthStore
  now?: () => Date
  newId?: () => string
}

export interface EvaluateHealthInput {
  organizationId: string
  eventId: string
  triggerType: 'risk_evaluation' | 'manual'
  triggerKey: string
  at?: Date
}

const CATEGORY_CAPS: Record<HealthFactorCategory, number> = {
  task: 30,
  vendor: 35,
  dependency: 25,
  inbox: 20,
  change: 15,
}

const RISK_CATEGORY: Record<RiskType, HealthFactorCategory> = {
  task_overdue: 'task',
  task_due_soon: 'task',
  vendor_unconfirmed: 'vendor',
  vendor_declined: 'vendor',
  vendor_schedule_review: 'vendor',
  dependency_unresolved: 'dependency',
  change_dependency_pending: 'dependency',
  critical_inbox_item: 'inbox',
  recent_sensitive_change: 'change',
}

export class HealthEngine {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: HealthEngineDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async evaluateEvent(input: EvaluateHealthInput): Promise<HealthEvaluationResult> {
    if (!input.organizationId.trim() || !input.eventId.trim()) throw new HealthValidationError('organizationId and eventId are required')
    if (!input.triggerKey.trim()) throw new HealthValidationError('triggerKey is required')
    const snapshot = await this.deps.store.loadSnapshot(input.organizationId, input.eventId)
    if (!snapshot) throw new HealthNotFoundError()
    const at = input.at ?? this.now()
    const computed = this.compute(snapshot)
    const previousScore = snapshot.event.healthScore
    const evaluation: EventHealthEvaluation = {
      id: this.newId(),
      organizationId: input.organizationId,
      eventId: input.eventId,
      triggerType: input.triggerType,
      triggerKey: input.triggerKey,
      previousScore,
      score: computed.score,
      delta: computed.score - previousScore,
      status: healthStatusForScore(computed.score),
      breakdown: computed.breakdown,
      evaluatedAt: at,
    }
    const changed = previousScore !== evaluation.score || snapshot.latestEvaluation?.status !== evaluation.status
    const domainEvent = changed ? {
      id: this.newId(), organizationId: input.organizationId, eventType: 'health.updated', aggregateType: 'event', aggregateId: input.eventId,
      occurredAt: at,
      payload: {
        eventId: input.eventId,
        previousScore,
        score: evaluation.score,
        delta: evaluation.delta,
        status: evaluation.status,
        activeRiskCount: evaluation.breakdown.activeRiskCount,
        criticalCount: evaluation.breakdown.criticalCount,
        highCount: evaluation.breakdown.highCount,
        totalPenalty: evaluation.breakdown.totalPenalty,
        topFactors: evaluation.breakdown.topFactors,
      },
    } : null
    return this.deps.store.reconcileEvaluation(evaluation, domainEvent)
  }

  async evaluateDomainEvent(message: OutboxMessage): Promise<HealthEvaluationResult | null> {
    if (message.eventType !== 'risk.evaluation_completed') return null
    const eventId = typeof message.payload.eventId === 'string' ? message.payload.eventId : message.aggregateId
    if (!eventId) return null
    return this.evaluateEvent({
      organizationId: message.organizationId,
      eventId,
      triggerType: 'risk_evaluation',
      triggerKey: `risk:${message.id}`,
      at: this.now(),
    })
  }

  async getCurrent(organizationId: string, eventId: string): Promise<EventHealthCurrent> {
    const snapshot = await this.deps.store.loadSnapshot(organizationId, eventId)
    if (!snapshot) throw new HealthNotFoundError()
    return currentFromSnapshot(snapshot)
  }

  async workspace(organizationId: string, limit = 30): Promise<EventHealthCurrent[]> {
    if (!organizationId.trim()) throw new HealthValidationError('organizationId is required')
    return this.deps.store.listCurrent(organizationId, clamp(limit, 1, 100))
  }

  history(organizationId: string, eventId: string, limit = 30): Promise<EventHealthEvaluation[]> {
    if (!organizationId.trim() || !eventId.trim()) throw new HealthValidationError('organizationId and eventId are required')
    return this.deps.store.listHistory(organizationId, eventId, clamp(limit, 1, 100))
  }

  compute(snapshot: HealthSnapshot): { score: number; breakdown: HealthBreakdown } {
    const activeRisks = snapshot.activeRisks.filter((risk) => risk.status === 'open' || risk.status === 'acknowledged')
    const factors = activeRisks.map(toFactor).sort((a, b) => b.penalty - a.penalty || b.riskScore - a.riskScore)
    const categoryPenalties: Record<HealthFactorCategory, number> = { task: 0, vendor: 0, dependency: 0, inbox: 0, change: 0 }
    for (const factor of factors) categoryPenalties[factor.category] += factor.penalty
    for (const category of Object.keys(categoryPenalties) as HealthFactorCategory[]) {
      categoryPenalties[category] = Math.min(CATEGORY_CAPS[category], categoryPenalties[category])
    }

    const totalPenalty = Math.min(100, Object.values(categoryPenalties).reduce((sum, value) => sum + value, 0))
    const counts = {
      critical: activeRisks.filter((risk) => risk.severity === 'critical').length,
      high: activeRisks.filter((risk) => risk.severity === 'high').length,
      medium: activeRisks.filter((risk) => risk.severity === 'medium').length,
      low: activeRisks.filter((risk) => risk.severity === 'low').length,
    }
    const severityCeiling = counts.critical >= 2 ? 49 : counts.critical === 1 ? 69 : counts.high >= 1 ? 84 : 100
    const score = Math.max(0, Math.min(severityCeiling, 100 - totalPenalty))
    const breakdown: HealthBreakdown = {
      baseScore: 100,
      totalPenalty,
      severityCeiling,
      activeRiskCount: activeRisks.length,
      acknowledgedRiskCount: activeRisks.filter((risk) => risk.status === 'acknowledged').length,
      criticalCount: counts.critical,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      categoryPenalties,
      topFactors: factors.slice(0, 5),
    }
    return { score, breakdown }
  }
}

function toFactor(risk: EventRisk): HealthFactor {
  return {
    riskId: risk.id,
    riskType: risk.type,
    severity: risk.severity,
    category: RISK_CATEGORY[risk.type],
    title: risk.title,
    riskScore: risk.score,
    penalty: Math.max(1, Math.ceil(risk.score / 5)),
  }
}

function currentFromSnapshot(snapshot: HealthSnapshot): EventHealthCurrent {
  const latest = snapshot.latestEvaluation
  return {
    event: snapshot.event,
    score: snapshot.event.healthScore,
    status: latest?.status ?? healthStatusForScore(snapshot.event.healthScore),
    breakdown: latest?.breakdown ?? null,
    evaluatedAt: latest?.evaluatedAt ?? null,
    delta: latest?.delta ?? null,
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return min
  return Math.max(min, Math.min(max, value))
}
