import type { Kysely, Selectable, Transaction } from 'kysely'
import type {
  DependencyEntityUpdate,
  DependencyEvaluation,
  DependencyImpact,
  DependencyStore,
  DomainEvent,
  ListDependencyImpactsInput,
} from '@ecc/domain'
import { DependencyConflictError } from '@ecc/domain'
import type { DatabaseSchema, DependencyImpactsTable } from '../db-types.ts'

export class KyselyDependencyStore implements DependencyStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async hasEvaluation(organizationId: string, sourceChangeEventId: string): Promise<boolean> {
    const row = await this.db.selectFrom('dependency_evaluations').select('id').where('organization_id','=',organizationId).where('source_change_event_id','=',sourceChangeEventId).executeTakeFirst()
    return Boolean(row)
  }

  async findById(organizationId: string, impactId: string): Promise<DependencyImpact | null> {
    const row = await this.db.selectFrom('dependency_impacts').selectAll()
      .where('organization_id','=',organizationId).where('id','=',impactId).executeTakeFirst()
    return row ? mapImpact(row) : null
  }

  async list(input: ListDependencyImpactsInput): Promise<DependencyImpact[]> {
    let query = this.db.selectFrom('dependency_impacts').selectAll().where('organization_id','=',input.organizationId)
    if (input.eventId) query = query.where('event_id','=',input.eventId)
    if (input.proposalId) query = query.where('proposal_id','=',input.proposalId)
    if (input.status) query = query.where('status','=',input.status)
    if (input.action) query = query.where('action','=',input.action)
    if (input.dependencyType) query = query.where('dependency_type','=',input.dependencyType)
    const rows = await query.orderBy('created_at','desc').limit(clamp(input.limit)).execute()
    return rows.map(mapImpact)
  }

  async findBySourceChangeEvent(organizationId: string, sourceChangeEventId: string): Promise<DependencyImpact[]> {
    const rows = await this.db.selectFrom('dependency_impacts').selectAll()
      .where('organization_id','=',organizationId).where('source_change_event_id','=',sourceChangeEventId)
      .orderBy('created_at').execute()
    return rows.map(mapImpact)
  }

  async createEvaluation(evaluation: DependencyEvaluation, impacts: DependencyImpact[], domainEvents: DomainEvent[]): Promise<{ impacts: DependencyImpact[]; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto('dependency_evaluations').values({ id:evaluation.id, organization_id:evaluation.organizationId, event_id:evaluation.eventId, proposal_id:evaluation.proposalId, source_change_event_id:evaluation.sourceChangeEventId, change_type:evaluation.changeType, impact_count:evaluation.impactCount, created_at:evaluation.createdAt })
        .onConflict((oc)=>oc.columns(['organization_id','source_change_event_id']).doNothing()).returning('id').executeTakeFirst()
      if (!inserted) {
        const existing = await trx.selectFrom('dependency_impacts').selectAll().where('organization_id','=',evaluation.organizationId).where('source_change_event_id','=',evaluation.sourceChangeEventId).orderBy('created_at').execute()
        return { impacts: existing.map(mapImpact), created:false }
      }
      if (impacts.length) await trx.insertInto('dependency_impacts').values(impacts.map(impactValues)).execute()
      for (const event of domainEvents) await insertOutbox(trx, event)
      return { impacts, created:true }
    })
  }

  async applySuggestion(impact: DependencyImpact, update: DependencyEntityUpdate, domainEvent: DomainEvent): Promise<{ impact: DependencyImpact; applied: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom('dependency_impacts').selectAll()
        .where('organization_id','=',impact.organizationId).where('id','=',impact.id).forUpdate().executeTakeFirst()
      if (!locked) throw new DependencyConflictError('Dependency impact disappeared during application')
      const currentImpact = mapImpact(locked)
      if (currentImpact.status === 'applied') return { impact: currentImpact, applied: false }
      if (currentImpact.status !== 'open') throw new DependencyConflictError(`Dependency impact is ${currentImpact.status} and cannot be applied`)
      await applyEntityUpdate(trx, currentImpact, update, domainEvent.occurredAt)
      const now = domainEvent.occurredAt
      const updated = await trx.updateTable('dependency_impacts').set({ status:'applied', updated_at:now, resolved_at:now })
        .where('organization_id','=',impact.organizationId).where('id','=',impact.id).where('status','=','open').returningAll().executeTakeFirstOrThrow()
      await insertOutbox(trx, domainEvent)
      return { impact: mapImpact(updated), applied: true }
    })
  }

  async resolveReview(impact: DependencyImpact, domainEvent: DomainEvent): Promise<{ impact: DependencyImpact; resolved: boolean }> {
    return this.finish(impact, 'resolved', domainEvent, 'resolved')
  }

  async dismiss(impact: DependencyImpact, domainEvent: DomainEvent): Promise<{ impact: DependencyImpact; dismissed: boolean }> {
    const result = await this.finish(impact, 'dismissed', domainEvent, 'dismissed')
    return { impact: result.impact, dismissed: result.resolved }
  }

  private async finish(impact: DependencyImpact, status: 'resolved'|'dismissed', event: DomainEvent, verb: string): Promise<{ impact: DependencyImpact; resolved: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('dependency_impacts').selectAll()
        .where('organization_id','=',impact.organizationId).where('id','=',impact.id).forUpdate().executeTakeFirst()
      if (!current) throw new DependencyConflictError(`Dependency impact disappeared while being ${verb}`)
      const mapped = mapImpact(current)
      if (mapped.status === status) return { impact: mapped, resolved: false }
      if (mapped.status !== 'open') throw new DependencyConflictError(`Dependency impact is ${mapped.status} and cannot be ${verb}`)
      const now = event.occurredAt
      const updated = await trx.updateTable('dependency_impacts').set({ status, updated_at:now, resolved_at:now })
        .where('organization_id','=',impact.organizationId).where('id','=',impact.id).where('status','=','open').returningAll().executeTakeFirstOrThrow()
      await insertOutbox(trx, event)
      return { impact: mapImpact(updated), resolved: true }
    })
  }
}

async function applyEntityUpdate(trx: Transaction<DatabaseSchema>, impact: DependencyImpact, update: DependencyEntityUpdate, at?: Date): Promise<void> {
  if (update.entityType !== impact.entityType || update.entityId !== impact.entityId) throw new DependencyConflictError('Dependency update does not match persisted impact target')
  if (update.entityType === 'task') {
    const row = await trx.selectFrom('event_tasks').select(['due_at']).where('organization_id','=',impact.organizationId).where('event_id','=',impact.eventId).where('id','=',update.entityId).forUpdate().executeTakeFirst()
    if (!row) throw new DependencyConflictError('Task no longer exists')
    assertIsoEqual(row.due_at, impact.currentValue.dueAt, 'Task due date changed after dependency evaluation')
    await trx.updateTable('event_tasks').set({ due_at:update.dueAt, updated_at:at ?? new Date() }).where('organization_id','=',impact.organizationId).where('id','=',update.entityId).execute()
    return
  }
  if (update.entityType === 'milestone') {
    const row = await trx.selectFrom('event_milestones').select(['due_at']).where('organization_id','=',impact.organizationId).where('event_id','=',impact.eventId).where('id','=',update.entityId).forUpdate().executeTakeFirst()
    if (!row) throw new DependencyConflictError('Milestone no longer exists')
    assertIsoEqual(row.due_at, impact.currentValue.dueAt, 'Milestone due date changed after dependency evaluation')
    await trx.updateTable('event_milestones').set({ due_at:update.dueAt, updated_at:at ?? new Date() }).where('organization_id','=',impact.organizationId).where('id','=',update.entityId).execute()
    return
  }
  const row = await trx.selectFrom('event_vendors').select(['arrival_at','departure_at']).where('organization_id','=',impact.organizationId).where('event_id','=',impact.eventId).where('id','=',update.entityId).forUpdate().executeTakeFirst()
  if (!row) throw new DependencyConflictError('Event vendor no longer exists')
  assertNullableIsoEqual(row.arrival_at, impact.currentValue.arrivalAt, 'Vendor arrival changed after dependency evaluation')
  assertNullableIsoEqual(row.departure_at, impact.currentValue.departureAt, 'Vendor departure changed after dependency evaluation')
  await trx.updateTable('event_vendors').set({ arrival_at:update.arrivalAt, departure_at:update.departureAt, updated_at:at ?? new Date() }).where('organization_id','=',impact.organizationId).where('id','=',update.entityId).execute()
}

function assertIsoEqual(actual: Date, expected: unknown, message: string): void {
  if (typeof expected !== 'string' || actual.toISOString() !== expected) throw new DependencyConflictError(message)
}
function assertNullableIsoEqual(actual: Date | null, expected: unknown, message: string): void {
  const a = actual?.toISOString() ?? null
  const e = typeof expected === 'string' ? expected : expected === null ? null : undefined
  if (a !== e) throw new DependencyConflictError(message)
}
function impactValues(i: DependencyImpact) { return {
  id:i.id, organization_id:i.organizationId, event_id:i.eventId, proposal_id:i.proposalId, source_change_event_id:i.sourceChangeEventId,
  rule_key:i.ruleKey, dependency_type:i.dependencyType, entity_type:i.entityType, entity_id:i.entityId, action:i.action, severity:i.severity,
  status:i.status, title:i.title, description:i.description, current_value:i.currentValue, suggested_value:i.suggestedValue, metadata:i.metadata,
  created_at:i.createdAt, updated_at:i.updatedAt, resolved_at:i.resolvedAt,
} }
function mapImpact(r: Selectable<DependencyImpactsTable>): DependencyImpact { return {
  id:r.id, organizationId:r.organization_id, eventId:r.event_id, proposalId:r.proposal_id, sourceChangeEventId:r.source_change_event_id,
  ruleKey:r.rule_key, dependencyType:r.dependency_type, entityType:r.entity_type, entityId:r.entity_id, action:r.action, severity:r.severity,
  status:r.status, title:r.title, description:r.description, currentValue:r.current_value, suggestedValue:r.suggested_value, metadata:r.metadata,
  createdAt:r.created_at, updatedAt:r.updated_at, resolvedAt:r.resolved_at,
} }
async function insertOutbox(trx: Transaction<DatabaseSchema>, event: DomainEvent): Promise<void> { await trx.insertInto('outbox_events').values({ id:event.id, organization_id:event.organizationId, event_type:event.eventType, aggregate_type:event.aggregateType, aggregate_id:event.aggregateId, payload:event.payload, occurred_at:event.occurredAt, available_at:event.occurredAt, claimed_at:null, claimed_by:null, dispatched_at:null, last_error:null }).execute() }
function clamp(value: number | undefined): number { return !value || !Number.isInteger(value) || value < 1 ? 50 : Math.min(value, 250) }
