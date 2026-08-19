import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import type {
  DomainEvent,
  Event,
  EventHealthCurrent,
  EventHealthEvaluation,
  EventRisk,
  HealthEvaluationResult,
  HealthSnapshot,
  HealthStore,
} from '@ecc/domain'
import { healthStatusForScore } from '@ecc/domain'
import type { DatabaseSchema, EventHealthEvaluationsTable, EventRisksTable, EventsTable } from '../db-types.ts'

export class KyselyHealthStore implements HealthStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async loadSnapshot(organizationId: string, eventId: string): Promise<HealthSnapshot | null> {
    const eventRow = await this.db.selectFrom('events').selectAll()
      .where('organization_id','=',organizationId).where('id','=',eventId).executeTakeFirst()
    if (!eventRow) return null
    const [riskRows, latestRow] = await Promise.all([
      this.db.selectFrom('event_risks').selectAll()
        .where('organization_id','=',organizationId).where('event_id','=',eventId)
        .where('status','in',['open','acknowledged']).orderBy('score','desc').execute(),
      this.db.selectFrom('event_health_evaluations').selectAll()
        .where('organization_id','=',organizationId).where('event_id','=',eventId)
        .orderBy('evaluated_at','desc').limit(1).executeTakeFirst(),
    ])
    return { event: mapEvent(eventRow), activeRisks: riskRows.map(mapRisk), latestEvaluation: latestRow ? mapEvaluation(latestRow) : null }
  }

  async reconcileEvaluation(evaluation: EventHealthEvaluation, domainEvent: DomainEvent | null): Promise<HealthEvaluationResult> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`health:${evaluation.organizationId}:${evaluation.eventId}`}))`.execute(trx)
      const existing = await trx.selectFrom('event_health_evaluations').selectAll()
        .where('organization_id','=',evaluation.organizationId).where('event_id','=',evaluation.eventId)
        .where('trigger_key','=',evaluation.triggerKey).executeTakeFirst()
      if (existing) return { evaluation: mapEvaluation(existing), duplicate: true, changed: false }

      const event = await trx.selectFrom('events').select(['health_score'])
        .where('organization_id','=',evaluation.organizationId).where('id','=',evaluation.eventId).forUpdate().executeTakeFirstOrThrow()
      const changed = event.health_score !== evaluation.score
      const normalized: EventHealthEvaluation = {
        ...evaluation,
        previousScore: event.health_score,
        delta: evaluation.score - event.health_score,
      }
      if (changed) {
        await trx.updateTable('events').set({ health_score: normalized.score, updated_at: normalized.evaluatedAt })
          .where('organization_id','=',normalized.organizationId).where('id','=',normalized.eventId).execute()
      }
      await trx.insertInto('event_health_evaluations').values({
        id: normalized.id,
        organization_id: normalized.organizationId,
        event_id: normalized.eventId,
        trigger_type: normalized.triggerType,
        trigger_key: normalized.triggerKey,
        previous_score: normalized.previousScore,
        score: normalized.score,
        delta: normalized.delta,
        status: normalized.status,
        breakdown: normalized.breakdown,
        evaluated_at: normalized.evaluatedAt,
      }).execute()
      if (domainEvent && changed) {
        await insertOutbox(trx, {
          ...domainEvent,
          payload: { ...domainEvent.payload, previousScore: normalized.previousScore, score: normalized.score, delta: normalized.delta },
        })
      }
      return { evaluation: normalized, duplicate: false, changed }
    })
  }

  async findLatest(organizationId: string, eventId: string): Promise<EventHealthEvaluation | null> {
    const row = await this.db.selectFrom('event_health_evaluations').selectAll()
      .where('organization_id','=',organizationId).where('event_id','=',eventId)
      .orderBy('evaluated_at','desc').limit(1).executeTakeFirst()
    return row ? mapEvaluation(row) : null
  }

  async listHistory(organizationId: string, eventId: string, limit = 30): Promise<EventHealthEvaluation[]> {
    const rows = await this.db.selectFrom('event_health_evaluations').selectAll()
      .where('organization_id','=',organizationId).where('event_id','=',eventId)
      .orderBy('evaluated_at','desc').limit(clamp(limit)).execute()
    return rows.map(mapEvaluation)
  }

  async listCurrent(organizationId: string, limit = 30): Promise<EventHealthCurrent[]> {
    const eventRows = await this.db.selectFrom('events').selectAll()
      .where('organization_id','=',organizationId).where('status','not in',['completed','cancelled'])
      .orderBy('health_score','asc').orderBy('start_at','asc').limit(clamp(limit,100)).execute()
    const result: EventHealthCurrent[] = []
    for (const row of eventRows) {
      const latest = await this.findLatest(organizationId,row.id)
      result.push({
        event: mapEvent(row),
        score: row.health_score,
        status: latest?.status ?? healthStatusForScore(row.health_score),
        breakdown: latest?.breakdown ?? null,
        evaluatedAt: latest?.evaluatedAt ?? null,
        delta: latest?.delta ?? null,
      })
    }
    return result.sort((a,b)=>a.score-b.score||a.event.startAt.getTime()-b.event.startAt.getTime())
  }
}

async function insertOutbox(trx: Transaction<DatabaseSchema>, event: DomainEvent): Promise<void> {
  await trx.insertInto('outbox_events').values({
    id:event.id, organization_id:event.organizationId, event_type:event.eventType, aggregate_type:event.aggregateType,
    aggregate_id:event.aggregateId, payload:event.payload, occurred_at:event.occurredAt, available_at:event.occurredAt,
    claimed_at:null, claimed_by:null, dispatched_at:null, last_error:null,
  }).execute()
}

function mapEvaluation(row: Selectable<EventHealthEvaluationsTable>): EventHealthEvaluation {
  return { id:row.id, organizationId:row.organization_id, eventId:row.event_id, triggerType:row.trigger_type, triggerKey:row.trigger_key,
    previousScore:row.previous_score, score:row.score, delta:row.delta, status:row.status, breakdown:row.breakdown, evaluatedAt:row.evaluated_at }
}
function mapEvent(row: Selectable<EventsTable>): Event {
  return { id:row.id,organizationId:row.organization_id,templateId:row.template_id,name:row.name,type:row.type,startAt:row.start_at,endAt:row.end_at,
    venueName:row.venue_name,venueAddress:row.venue_address,guestCount:row.guest_count,status:row.status,healthScore:row.health_score,
    ownerUserId:row.owner_user_id,createdAt:row.created_at,updatedAt:row.updated_at }
}
function mapRisk(row: Selectable<EventRisksTable>): EventRisk {
  return { id:row.id,organizationId:row.organization_id,eventId:row.event_id,riskKey:row.risk_key,type:row.type,severity:row.severity,score:row.score,
    status:row.status,sourceType:row.source_type,sourceId:row.source_id,title:row.title,description:row.description,metadata:row.metadata,
    firstDetectedAt:row.first_detected_at,lastDetectedAt:row.last_detected_at,acknowledgedAt:row.acknowledged_at,acknowledgedBy:row.acknowledged_by,
    resolvedAt:row.resolved_at,createdAt:row.created_at,updatedAt:row.updated_at }
}
function clamp(value:number|undefined,max=100):number{if(!value||!Number.isInteger(value)||value<1)return 30;return Math.min(value,max)}
