import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import {
  EventDayConflictError,
  type DomainEvent,
  type Event,
  type EventDayActivity,
  type EventDaySession,
  type EventDaySource,
  type EventDayStore,
  type EventDayTaskRecord,
  type EventDayTaskStatus,
} from '@ecc/domain'
import type {
  DatabaseSchema,
  EventDayActivityTable,
  EventDaySessionsTable,
  EventsTable,
} from '../db-types.ts'

export class KyselyEventDayStore implements EventDayStore {
  constructor(private readonly db:Kysely<DatabaseSchema>){}

  async loadSource(organizationId:string,eventId:string):Promise<EventDaySource|null>{
    const eventRow=await this.db.selectFrom('events as e')
      .innerJoin('organizations as o','o.id','e.organization_id')
      .selectAll('e').select('o.timezone as organization_timezone')
      .where('e.organization_id','=',organizationId).where('e.id','=',eventId).executeTakeFirst()
    if(!eventRow)return null

    const [settingsRow,sessionRow,vendorRows,taskRows,activityRows]=await Promise.all([
      this.db.selectFrom('event_day_settings').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).executeTakeFirst(),
      this.db.selectFrom('event_day_sessions').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).orderBy('started_at','desc').limit(1).executeTakeFirst(),
      this.db.selectFrom('event_vendors').select(['id','vendor_name','category','confirmation_status','arrival_at','departure_at','actual_arrival_at','actual_departure_at'])
        .where('organization_id','=',organizationId).where('event_id','=',eventId).orderBy('arrival_at','asc').orderBy('vendor_name','asc').execute(),
      this.db.selectFrom('event_tasks').select(['id','title','description','event_day_kind','status','priority','due_at','source','created_at','updated_at','completed_at'])
        .where('organization_id','=',organizationId).where('event_id','=',eventId).where('phase','=','event_day').orderBy('due_at','asc').orderBy('created_at','asc').execute(),
      this.db.selectFrom('event_day_activity').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).orderBy('occurred_at','asc').execute(),
    ])

    return {
      organizationId,
      timezone:eventRow.organization_timezone,
      enabled:settingsRow?.enabled??false,
      event:mapEvent(eventRow),
      session:sessionRow?mapSession(sessionRow):null,
      vendors:vendorRows.map(row=>({
        id:row.id,vendorName:row.vendor_name,category:row.category,confirmationStatus:row.confirmation_status,
        plannedArrivalAt:row.arrival_at,plannedDepartureAt:row.departure_at,
        actualArrivalAt:row.actual_arrival_at,actualDepartureAt:row.actual_departure_at,
      })),
      tasks:taskRows.map(row=>({
        id:row.id,title:row.title,description:row.description,kind:requireTaskKind(row.event_day_kind),status:row.status,priority:row.priority,
        dueAt:row.due_at,source:normalizeTaskSource(row.source),createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,
      })),
      activity:activityRows.map(mapActivity),
    }
  }

  async enable(input:{organizationId:string;eventId:string;at:Date;sender:string;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.organizationId,input.eventId)
      await requireEvent(trx,input.organizationId,input.eventId)
      const current=await trx.selectFrom('event_day_settings').select(['enabled']).where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).forUpdate().executeTakeFirst()
      if(current?.enabled)return{duplicate:true}
      await upsertSetting(trx,input.organizationId,input.eventId,true,input.sender,input.at)
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false}
    })
  }

  async disable(input:{organizationId:string;eventId:string;at:Date;sender:string;activity:EventDayActivity|null;domainEvent:DomainEvent}):Promise<{duplicate:boolean;sessionCompleted:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.organizationId,input.eventId)
      await requireEvent(trx,input.organizationId,input.eventId)
      const current=await trx.selectFrom('event_day_settings').select(['enabled']).where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).forUpdate().executeTakeFirst()
      const active=await trx.selectFrom('event_day_sessions').selectAll()
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('status','=','active').forUpdate().executeTakeFirst()
      if(current?.enabled===false&&!active)return{duplicate:true,sessionCompleted:false}
      if(!current&&!active)return{duplicate:true,sessionCompleted:false}

      await upsertSetting(trx,input.organizationId,input.eventId,false,input.sender,input.at)
      if(active){
        await trx.updateTable('event_day_sessions').set({
          status:'completed',completed_at:input.at,completion_reason:'disabled',completed_by_sender:input.sender,updated_at:input.at,
        }).where('id','=',active.id).execute()
        await trx.updateTable('events').set({status:restorableStatus(active.previous_event_status),updated_at:input.at})
          .where('organization_id','=',input.organizationId).where('id','=',input.eventId).execute()
        if(input.activity)await insertActivity(trx,input.activity)
      }
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false,sessionCompleted:Boolean(active)}
    })
  }

  async startSession(input:{session:EventDaySession;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{session:EventDaySession;duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.session.organizationId,input.session.eventId)
      const settings=await trx.selectFrom('event_day_settings').select(['enabled']).where('organization_id','=',input.session.organizationId).where('event_id','=',input.session.eventId).forUpdate().executeTakeFirst()
      if(!settings?.enabled)throw new EventDayConflictError('Event Day is disabled for this event')
      const existing=await trx.selectFrom('event_day_sessions').selectAll()
        .where('organization_id','=',input.session.organizationId).where('event_id','=',input.session.eventId).where('status','=','active').forUpdate().executeTakeFirst()
      if(existing)return{session:mapSession(existing),duplicate:true}

      const event=await requireEvent(trx,input.session.organizationId,input.session.eventId)
      if(event.status==='cancelled'||event.status==='completed'||event.status==='event_day')throw new EventDayConflictError(`Cannot start Event Day from event status ${event.status}`)

      await trx.insertInto('event_day_sessions').values({
        id:input.session.id,organization_id:input.session.organizationId,event_id:input.session.eventId,status:'active',
        previous_event_status:input.session.previousEventStatus,started_at:input.session.startedAt,completed_at:null,completion_reason:null,
        started_by_sender:input.session.startedBySender,completed_by_sender:null,created_at:input.session.createdAt,updated_at:input.session.updatedAt,
      }).execute()
      await trx.updateTable('events').set({status:'event_day',updated_at:input.session.startedAt})
        .where('organization_id','=',input.session.organizationId).where('id','=',input.session.eventId).execute()
      await insertActivity(trx,input.activity)
      await insertOutbox(trx,input.domainEvent)
      return{session:input.session,duplicate:false}
    })
  }

  async markVendorArrived(input:{organizationId:string;eventId:string;eventVendorId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.organizationId,input.eventId)
      await requireEnabled(trx,input.organizationId,input.eventId)
      await requireActiveSession(trx,input.organizationId,input.eventId)
      const vendor=await trx.selectFrom('event_vendors').select(['actual_arrival_at'])
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('id','=',input.eventVendorId).forUpdate().executeTakeFirst()
      if(!vendor)throw new EventDayConflictError('Event vendor does not exist')
      if(vendor.actual_arrival_at)return{duplicate:true}
      await trx.updateTable('event_vendors').set({actual_arrival_at:input.at,updated_at:input.at})
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('id','=',input.eventVendorId).execute()
      await insertActivity(trx,input.activity)
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false}
    })
  }

  async markVendorDeparted(input:{organizationId:string;eventId:string;eventVendorId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.organizationId,input.eventId)
      await requireEnabled(trx,input.organizationId,input.eventId)
      await requireActiveSession(trx,input.organizationId,input.eventId)
      const vendor=await trx.selectFrom('event_vendors').select(['actual_arrival_at','actual_departure_at'])
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('id','=',input.eventVendorId).forUpdate().executeTakeFirst()
      if(!vendor)throw new EventDayConflictError('Event vendor does not exist')
      if(vendor.actual_departure_at)return{duplicate:true}
      if(!vendor.actual_arrival_at)throw new EventDayConflictError('Vendor departure cannot be recorded before arrival')
      await trx.updateTable('event_vendors').set({actual_departure_at:input.at,updated_at:input.at})
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('id','=',input.eventVendorId).execute()
      await insertActivity(trx,input.activity)
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false}
    })
  }

  async completeSession(input:{organizationId:string;eventId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.organizationId,input.eventId)
      await requireEnabled(trx,input.organizationId,input.eventId)
      const session=await trx.selectFrom('event_day_sessions').selectAll()
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('status','=','active').forUpdate().executeTakeFirst()
      if(!session){
        const latest=await trx.selectFrom('event_day_sessions').select(['status']).where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).orderBy('started_at','desc').limit(1).executeTakeFirst()
        if(latest?.status==='completed')return{duplicate:true}
        throw new EventDayConflictError('Event Day has not been started')
      }
      await trx.updateTable('event_day_sessions').set({status:'completed',completed_at:input.at,completion_reason:'manual',completed_by_sender:input.sender,updated_at:input.at})
        .where('id','=',session.id).execute()
      await trx.updateTable('events').set({status:restorableStatus(session.previous_event_status),updated_at:input.at})
        .where('organization_id','=',input.organizationId).where('id','=',input.eventId).execute()
      await insertActivity(trx,input.activity)
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false}
    })
  }

  async createTask(input:{task:EventDayTaskRecord;domainEvent:DomainEvent}):Promise<void>{
    await this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.task.organizationId,input.task.eventId)
      await requireEnabled(trx,input.task.organizationId,input.task.eventId)
      await requireEvent(trx,input.task.organizationId,input.task.eventId)
      await trx.insertInto('event_tasks').values({
        id:input.task.id,organization_id:input.task.organizationId,event_id:input.task.eventId,template_task_id:null,source_command_request_id:null,
        title:input.task.title,description:input.task.description,type:'general',status:input.task.status,priority:input.task.priority,due_at:input.task.dueAt,
        source:input.task.source,phase:'event_day',event_day_kind:input.task.kind,created_at:input.task.createdAt,updated_at:input.task.updatedAt,completed_at:input.task.completedAt,
      }).execute()
      await insertOutbox(trx,input.domainEvent)
    })
  }

  async updateTask(input:{organizationId:string;eventId:string;taskId:string;status:EventDayTaskStatus;at:Date;sender:string;domainEvent:DomainEvent}):Promise<{duplicate:boolean;task:EventDayTaskRecord}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.organizationId,input.eventId)
      await requireEnabled(trx,input.organizationId,input.eventId)
      const row=await trx.selectFrom('event_tasks').select(['id','organization_id','event_id','title','description','event_day_kind','status','priority','due_at','source','created_at','updated_at','completed_at'])
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('id','=',input.taskId).where('phase','=','event_day').forUpdate().executeTakeFirst()
      if(!row)throw new EventDayConflictError('Event Day task does not exist')
      const current=mapTaskRecord(row)
      if(current.status===input.status)return{duplicate:true,task:current}
      const completedAt=input.status==='completed'?(current.completedAt??input.at):null
      await trx.updateTable('event_tasks').set({status:input.status,updated_at:input.at,completed_at:completedAt})
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).where('id','=',input.taskId).execute()
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false,task:{...current,status:input.status,updatedAt:input.at,completedAt}}
    })
  }
}

async function requireEvent(trx:Transaction<DatabaseSchema>,organizationId:string,eventId:string){
  const event=await trx.selectFrom('events').select(['status']).where('organization_id','=',organizationId).where('id','=',eventId).forUpdate().executeTakeFirst()
  if(!event)throw new EventDayConflictError('Event does not exist')
  return event
}
async function requireEnabled(trx:Transaction<DatabaseSchema>,organizationId:string,eventId:string):Promise<void>{
  const row=await trx.selectFrom('event_day_settings').select(['enabled']).where('organization_id','=',organizationId).where('event_id','=',eventId).executeTakeFirst()
  if(!row?.enabled)throw new EventDayConflictError('Event Day is disabled for this event')
}
async function requireActiveSession(trx:Transaction<DatabaseSchema>,organizationId:string,eventId:string):Promise<EventDaySession>{
  const row=await trx.selectFrom('event_day_sessions').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','=','active').forUpdate().executeTakeFirst()
  if(!row)throw new EventDayConflictError('Event Day has not been started')
  return mapSession(row)
}
async function upsertSetting(trx:Transaction<DatabaseSchema>,organizationId:string,eventId:string,enabled:boolean,sender:string,at:Date){
  await trx.insertInto('event_day_settings').values({organization_id:organizationId,event_id:eventId,enabled,updated_by_sender:sender,created_at:at,updated_at:at})
    .onConflict(oc=>oc.columns(['organization_id','event_id']).doUpdateSet({enabled,updated_by_sender:sender,updated_at:at})).execute()
}
async function lockEventDay(trx:Transaction<DatabaseSchema>,organizationId:string,eventId:string){
  await sql`select pg_advisory_xact_lock(hashtext(${`event-day:${organizationId}:${eventId}`}))`.execute(trx)
}
async function insertActivity(trx:Transaction<DatabaseSchema>,value:EventDayActivity){
  await trx.insertInto('event_day_activity').values({
    id:value.id,organization_id:value.organizationId,event_id:value.eventId,session_id:value.sessionId,event_vendor_id:value.eventVendorId,
    type:value.type,occurred_at:value.occurredAt,created_by_sender:value.createdBySender,note:value.note,created_at:value.createdAt,
  }).execute()
}
async function insertOutbox(trx:Transaction<DatabaseSchema>,event:DomainEvent){
  await trx.insertInto('outbox_events').values({
    id:event.id,organization_id:event.organizationId,event_type:event.eventType,aggregate_type:event.aggregateType,aggregate_id:event.aggregateId,
    payload:event.payload,occurred_at:event.occurredAt,available_at:event.occurredAt,claimed_at:null,claimed_by:null,dispatched_at:null,last_error:null,
  }).execute()
}
function mapSession(row:Selectable<EventDaySessionsTable>):EventDaySession{return{
  id:row.id,organizationId:row.organization_id,eventId:row.event_id,status:row.status,previousEventStatus:row.previous_event_status,
  startedAt:row.started_at,completedAt:row.completed_at,completionReason:row.completion_reason,startedBySender:row.started_by_sender,
  completedBySender:row.completed_by_sender,createdAt:row.created_at,updatedAt:row.updated_at,
}}
function mapActivity(row:Selectable<EventDayActivityTable>):EventDayActivity{return{
  id:row.id,organizationId:row.organization_id,eventId:row.event_id,sessionId:row.session_id,eventVendorId:row.event_vendor_id,type:row.type,
  occurredAt:row.occurred_at,createdBySender:row.created_by_sender,note:row.note,createdAt:row.created_at,
}}
function mapEvent(row:Selectable<EventsTable>):Event{return{
  id:row.id,organizationId:row.organization_id,templateId:row.template_id,name:row.name,type:row.type,startAt:row.start_at,endAt:row.end_at,
  venueName:row.venue_name,venueAddress:row.venue_address,guestCount:row.guest_count,status:row.status,healthScore:row.health_score,
  ownerUserId:row.owner_user_id,createdAt:row.created_at,updatedAt:row.updated_at,
}}
function mapTaskRecord(row:{
  id:string;organization_id:string;event_id:string;title:string;description:string|null;event_day_kind:import('@ecc/domain').EventDayTaskKind|null;
  status:EventDayTaskStatus;priority:import('@ecc/domain').EventDayTaskPriority;due_at:Date;source:string;created_at:Date;updated_at:Date;completed_at:Date|null
}):EventDayTaskRecord{return{
  id:row.id,organizationId:row.organization_id,eventId:row.event_id,title:row.title,description:row.description,kind:requireTaskKind(row.event_day_kind),
  status:row.status,priority:row.priority,dueAt:row.due_at,source:normalizeTaskSource(row.source),createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,
}}
function requireTaskKind(value:import('@ecc/domain').EventDayTaskKind|null):import('@ecc/domain').EventDayTaskKind{
  if(!value)throw new EventDayConflictError('Event Day task is missing event_day_kind')
  return value
}
function normalizeTaskSource(value:string):'manual'|'automation'|'ai'{return value==='automation'?'automation':value==='ai'?'ai':'manual'}
function restorableStatus(value:Event['status']):'draft'|'planning'|'confirmation'|'ready'{return value==='draft'||value==='confirmation'||value==='ready'?value:'planning'}
