import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import type {
  ActiveEventRef,
  DependencyImpact,
  DomainEvent,
  Event,
  EventRisk,
  EventTask,
  EventVendor,
  InboxItem,
  ListRisksInput,
  RiskAppliedChangeSnapshot,
  RiskCandidate,
  RiskEvaluation,
  RiskReconciliationResult,
  RiskSnapshot,
  RiskStore,
} from '@ecc/domain'
import { RiskConflictError } from '@ecc/domain'
import type {
  DatabaseSchema,
  EventRisksTable,
  EventTasksTable,
  EventVendorsTable,
  EventsTable,
  InboxItemsTable,
  DependencyImpactsTable,
} from '../db-types.ts'

export class KyselyRiskStore implements RiskStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async loadSnapshot(organizationId: string, eventId: string): Promise<RiskSnapshot | null> {
    const eventRow = await this.db.selectFrom('events').selectAll()
      .where('organization_id','=',organizationId).where('id','=',eventId).executeTakeFirst()
    if (!eventRow) return null

    const [taskRows, vendorRows, dependencyRows, inboxRows, changeRows] = await Promise.all([
      this.db.selectFrom('event_tasks').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).execute(),
      this.db.selectFrom('event_vendors').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).execute(),
      this.db.selectFrom('dependency_impacts').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','=','open').execute(),
      this.db.selectFrom('inbox_items').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','in',['open','in_progress']).execute(),
      this.db.selectFrom('change_proposals').select(['id','type','applied_at','current_value','proposed_value'])
        .where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','=','applied')
        .where('applied_at','is not',null).orderBy('applied_at','desc').limit(30).execute(),
    ])

    return {
      event: mapEvent(eventRow),
      tasks: taskRows.map(mapTask),
      vendors: vendorRows.map(mapVendor),
      dependencies: dependencyRows.map(mapDependency),
      inbox: inboxRows.map(mapInbox),
      appliedChanges: changeRows.flatMap((row): RiskAppliedChangeSnapshot[] => row.applied_at ? [{
        id: row.id, type: row.type, appliedAt: row.applied_at,
        currentValue: row.current_value, proposedValue: row.proposed_value,
      }] : []),
    }
  }

  async listActiveEventRefs(): Promise<ActiveEventRef[]> {
    const rows = await this.db.selectFrom('events').select(['organization_id','id'])
      .where('status','not in',['completed','cancelled']).execute()
    return rows.map((row) => ({ organizationId: row.organization_id, eventId: row.id }))
  }

  async findById(organizationId: string, riskId: string): Promise<EventRisk | null> {
    const row = await this.db.selectFrom('event_risks').selectAll()
      .where('organization_id','=',organizationId).where('id','=',riskId).executeTakeFirst()
    return row ? mapRisk(row) : null
  }

  async list(input: ListRisksInput): Promise<EventRisk[]> {
    let query = this.db.selectFrom('event_risks').selectAll().where('organization_id','=',input.organizationId)
    if (input.eventId) query = query.where('event_id','=',input.eventId)
    if (input.status) query = query.where('status','=',input.status)
    if (input.severity) query = query.where('severity','=',input.severity)
    if (input.type) query = query.where('type','=',input.type)
    if (input.minScore !== undefined) query = query.where('score','>=',input.minScore)
    const rows = await query.orderBy('score','desc').orderBy('last_detected_at','desc').limit(clamp(input.limit)).execute()
    return rows.map(mapRisk)
  }

  async listActive(organizationId: string, limit = 200): Promise<EventRisk[]> {
    const rows = await this.db.selectFrom('event_risks').selectAll()
      .where('organization_id','=',organizationId).where('status','in',['open','acknowledged'])
      .orderBy('score','desc').orderBy('last_detected_at','desc').limit(clamp(limit)).execute()
    return rows.map(mapRisk)
  }

  async reconcileEvaluation(evaluation: RiskEvaluation, candidates: RiskCandidate[]): Promise<RiskReconciliationResult> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`risk:${evaluation.organizationId}:${evaluation.eventId}`}))`.execute(trx)

      const duplicateEvaluation = await trx.selectFrom('risk_evaluations').select('id')
        .where('organization_id','=',evaluation.organizationId).where('event_id','=',evaluation.eventId)
        .where('trigger_key','=',evaluation.triggerKey).executeTakeFirst()
      if (duplicateEvaluation) {
        const active = await trx.selectFrom('event_risks').selectAll()
          .where('organization_id','=',evaluation.organizationId).where('event_id','=',evaluation.eventId)
          .where('status','in',['open','acknowledged']).orderBy('score','desc').execute()
        return { risks: active.map(mapRisk), detected:0, updated:0, resolved:0, duplicate:true }
      }

      const existingRows = await trx.selectFrom('event_risks').selectAll()
        .where('organization_id','=',evaluation.organizationId).where('event_id','=',evaluation.eventId)
        .forUpdate().execute()
      const existing = new Map<string, Selectable<EventRisksTable>>(existingRows.map((row) => [row.risk_key, row] as const))
      const desiredKeys = new Set(candidates.map((candidate) => candidate.riskKey))
      const active: EventRisk[] = []
      let detected = 0, updated = 0, resolved = 0

      for (const candidate of candidates) {
        const old = existing.get(candidate.riskKey)
        if (!old) {
          const risk: EventRisk = {
            ...candidate, status:'open', firstDetectedAt:evaluation.evaluatedAt, lastDetectedAt:evaluation.evaluatedAt,
            acknowledgedAt:null, acknowledgedBy:null, resolvedAt:null, createdAt:evaluation.evaluatedAt, updatedAt:evaluation.evaluatedAt,
          }
          await trx.insertInto('event_risks').values(riskValues(risk)).execute()
          await insertOutbox(trx, riskEvent(risk, 'risk.detected', evaluation.evaluatedAt, { reopened:false }))
          active.push(risk); detected++
          continue
        }

        const wasResolved = old.status === 'resolved'
        const materialChanged = old.type !== candidate.type || old.severity !== candidate.severity || old.score !== candidate.score ||
          old.source_type !== candidate.sourceType || old.source_id !== candidate.sourceId || old.title !== candidate.title ||
          old.description !== candidate.description || JSON.stringify(old.metadata) !== JSON.stringify(candidate.metadata)
        const status = wasResolved ? 'open' as const : old.status
        const row = await trx.updateTable('event_risks').set({
          type:candidate.type, severity:candidate.severity, score:candidate.score, status,
          source_type:candidate.sourceType, source_id:candidate.sourceId, title:candidate.title, description:candidate.description,
          metadata:candidate.metadata, last_detected_at:evaluation.evaluatedAt,
          acknowledged_at:wasResolved ? null : old.acknowledged_at,
          acknowledged_by:wasResolved ? null : old.acknowledged_by,
          resolved_at:null, updated_at:evaluation.evaluatedAt,
        }).where('id','=',old.id).returningAll().executeTakeFirstOrThrow()
        const risk = mapRisk(row); active.push(risk)
        if (wasResolved) {
          detected++
          await insertOutbox(trx, riskEvent(risk, 'risk.detected', evaluation.evaluatedAt, { reopened:true }))
        } else if (materialChanged) {
          updated++
          await insertOutbox(trx, riskEvent(risk, 'risk.updated', evaluation.evaluatedAt, {
            previousSeverity: old.severity, previousScore: old.score,
          }))
        }
      }

      for (const old of existingRows) {
        if ((old.status === 'open' || old.status === 'acknowledged') && !desiredKeys.has(old.risk_key)) {
          const row = await trx.updateTable('event_risks').set({
            status:'resolved', resolved_at:evaluation.evaluatedAt, updated_at:evaluation.evaluatedAt,
          }).where('id','=',old.id).returningAll().executeTakeFirstOrThrow()
          const risk = mapRisk(row); resolved++
          await insertOutbox(trx, riskEvent(risk, 'risk.resolved', evaluation.evaluatedAt, {}))
        }
      }

      await trx.insertInto('risk_evaluations').values({
        id:evaluation.id, organization_id:evaluation.organizationId, event_id:evaluation.eventId,
        trigger_type:evaluation.triggerType, trigger_key:evaluation.triggerKey,
        detected_count:detected, updated_count:updated, resolved_count:resolved, active_count:candidates.length,
        evaluated_at:evaluation.evaluatedAt,
      }).execute()
      await insertOutbox(trx, {
        id:crypto.randomUUID(), organizationId:evaluation.organizationId, eventType:'risk.evaluation_completed',
        aggregateType:'event', aggregateId:evaluation.eventId, occurredAt:evaluation.evaluatedAt,
        payload:{ eventId:evaluation.eventId, triggerType:evaluation.triggerType, triggerKey:evaluation.triggerKey,
          detectedCount:detected, updatedCount:updated, resolvedCount:resolved, activeCount:candidates.length },
      })

      active.sort((a,b) => b.score-a.score)
      return { risks:active, detected, updated, resolved, duplicate:false }
    })
  }

  async acknowledge(risk: EventRisk, sender: string, domainEvent: DomainEvent): Promise<{ risk: EventRisk; acknowledged: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('event_risks').selectAll()
        .where('organization_id','=',risk.organizationId).where('id','=',risk.id).forUpdate().executeTakeFirst()
      if (!current) throw new RiskConflictError('Risk disappeared before acknowledgement')
      if (current.status === 'resolved') throw new RiskConflictError('Resolved risk cannot be acknowledged')
      if (current.status === 'acknowledged') return { risk:mapRisk(current), acknowledged:false }
      const row = await trx.updateTable('event_risks').set({
        status:'acknowledged', acknowledged_at:domainEvent.occurredAt, acknowledged_by:sender, updated_at:domainEvent.occurredAt,
      }).where('id','=',risk.id).returningAll().executeTakeFirstOrThrow()
      await insertOutbox(trx, domainEvent)
      return { risk:mapRisk(row), acknowledged:true }
    })
  }
}

function riskValues(risk: EventRisk) {
  return { id:risk.id, organization_id:risk.organizationId, event_id:risk.eventId, risk_key:risk.riskKey,
    type:risk.type, severity:risk.severity, score:risk.score, status:risk.status, source_type:risk.sourceType,
    source_id:risk.sourceId, title:risk.title, description:risk.description, metadata:risk.metadata,
    first_detected_at:risk.firstDetectedAt, last_detected_at:risk.lastDetectedAt, acknowledged_at:risk.acknowledgedAt,
    acknowledged_by:risk.acknowledgedBy, resolved_at:risk.resolvedAt, created_at:risk.createdAt, updated_at:risk.updatedAt }
}
function riskEvent(risk:EventRisk,eventType:string,at:Date,extra:Record<string,unknown>):DomainEvent {
  return { id:crypto.randomUUID(), organizationId:risk.organizationId, eventType, aggregateType:'event_risk', aggregateId:risk.id,
    occurredAt:at, payload:{ riskId:risk.id,eventId:risk.eventId,riskType:risk.type,severity:risk.severity,score:risk.score,
      status:risk.status,sourceType:risk.sourceType,sourceId:risk.sourceId,title:risk.title,description:risk.description,...extra } }
}
async function insertOutbox(trx:Transaction<DatabaseSchema>,event:DomainEvent):Promise<void>{
  await trx.insertInto('outbox_events').values({ id:event.id,organization_id:event.organizationId,event_type:event.eventType,
    aggregate_type:event.aggregateType,aggregate_id:event.aggregateId,payload:event.payload,occurred_at:event.occurredAt,
    available_at:event.occurredAt,claimed_at:null,claimed_by:null,dispatched_at:null,last_error:null }).execute()
}
function clamp(value:number|undefined):number{if(!value||!Number.isInteger(value)||value<1)return 50;return Math.min(value,500)}
function mapRisk(row:Selectable<EventRisksTable>):EventRisk{return{id:row.id,organizationId:row.organization_id,eventId:row.event_id,riskKey:row.risk_key,
  type:row.type,severity:row.severity,score:row.score,status:row.status,sourceType:row.source_type,sourceId:row.source_id,title:row.title,
  description:row.description,metadata:row.metadata,firstDetectedAt:row.first_detected_at,lastDetectedAt:row.last_detected_at,
  acknowledgedAt:row.acknowledged_at,acknowledgedBy:row.acknowledged_by,resolvedAt:row.resolved_at,createdAt:row.created_at,updatedAt:row.updated_at}}
function mapEvent(row:Selectable<EventsTable>):Event{return{id:row.id,organizationId:row.organization_id,templateId:row.template_id,name:row.name,type:row.type,
  startAt:row.start_at,endAt:row.end_at,venueName:row.venue_name,venueAddress:row.venue_address,guestCount:row.guest_count,status:row.status,
  healthScore:row.health_score,ownerUserId:row.owner_user_id,createdAt:row.created_at,updatedAt:row.updated_at}}
function mapTask(row:Selectable<EventTasksTable>):EventTask{return{id:row.id,organizationId:row.organization_id,eventId:row.event_id,templateTaskId:row.template_task_id,
  sourceCommandRequestId:row.source_command_request_id,title:row.title,description:row.description,type:row.type,status:row.status,priority:row.priority,
  dueAt:row.due_at,source:row.source,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at}}
function mapVendor(row:Selectable<EventVendorsTable>):EventVendor{return{id:row.id,organizationId:row.organization_id,eventId:row.event_id,vendorId:row.vendor_id,
  vendorName:row.vendor_name,category:row.category,contactName:row.contact_name,phone:row.phone,email:row.email,confirmationStatus:row.confirmation_status,
  contractStatus:row.contract_status,paymentStatus:row.payment_status,arrivalAt:row.arrival_at,departureAt:row.departure_at,teamSize:row.team_size,
  confirmationRequestedAt:row.confirmation_requested_at,confirmationDeadlineAt:row.confirmation_deadline_at,confirmedAt:row.confirmed_at,
  declinedAt:row.declined_at,notes:row.notes,createdAt:row.created_at,updatedAt:row.updated_at}}
function mapDependency(row:Selectable<DependencyImpactsTable>):DependencyImpact{return{id:row.id,organizationId:row.organization_id,eventId:row.event_id,
  proposalId:row.proposal_id,sourceChangeEventId:row.source_change_event_id,ruleKey:row.rule_key,dependencyType:row.dependency_type,entityType:row.entity_type,
  entityId:row.entity_id,action:row.action,severity:row.severity,status:row.status,title:row.title,description:row.description,currentValue:row.current_value,
  suggestedValue:row.suggested_value,metadata:row.metadata,createdAt:row.created_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at}}
function mapInbox(row:Selectable<InboxItemsTable>):InboxItem{return{id:row.id,organizationId:row.organization_id,eventId:row.event_id,sourceEventId:row.source_event_id,
  type:row.type,severity:row.severity,sourceType:row.source_type,sourceId:row.source_id,title:row.title,description:row.description,status:row.status,
  assignedTo:row.assigned_to,metadata:row.metadata,createdAt:row.created_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at}}
