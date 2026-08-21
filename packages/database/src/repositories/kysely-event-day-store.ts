import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import {
  EventDayConflictError,
  type DomainEvent,
  type Event,
  type EventDayActivity,
  type EventDaySession,
  type EventDaySource,
  type EventDayStore,
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

    const [sessionRow,vendorRows,taskRows,activityRows]=await Promise.all([
      this.db.selectFrom('event_day_sessions').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).executeTakeFirst(),
      this.db.selectFrom('event_vendors').select(['id','vendor_name','category','confirmation_status','arrival_at','departure_at','actual_arrival_at','actual_departure_at'])
        .where('organization_id','=',organizationId).where('event_id','=',eventId).orderBy('arrival_at','asc').orderBy('vendor_name','asc').execute(),
      this.db.selectFrom('event_tasks').select(['id','title','status','priority','due_at'])
        .where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','in',['pending','in_progress']).orderBy('due_at','asc').execute(),
      this.db.selectFrom('event_day_activity').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).orderBy('occurred_at','asc').execute(),
    ])

    return {
      organizationId,
      timezone:eventRow.organization_timezone,
      event:mapEvent(eventRow),
      session:sessionRow?mapSession(sessionRow):null,
      vendors:vendorRows.map(row=>({
        id:row.id,vendorName:row.vendor_name,category:row.category,confirmationStatus:row.confirmation_status,
        plannedArrivalAt:row.arrival_at,plannedDepartureAt:row.departure_at,
        actualArrivalAt:row.actual_arrival_at,actualDepartureAt:row.actual_departure_at,
      })),
      tasks:taskRows.map(row=>({id:row.id,title:row.title,status:row.status,priority:row.priority,dueAt:row.due_at})),
      activity:activityRows.map(mapActivity),
    }
  }

  async startSession(input:{session:EventDaySession;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{session:EventDaySession;duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await lockEventDay(trx,input.session.organizationId,input.session.eventId)
      const existing=await trx.selectFrom('event_day_sessions').selectAll()
        .where('organization_id','=',input.session.organizationId).where('event_id','=',input.session.eventId).forUpdate().executeTakeFirst()
      if(existing)return{session:mapSession(existing),duplicate:true}

      const event=await trx.selectFrom('events').select(['status']).where('organization_id','=',input.session.organizationId).where('id','=',input.session.eventId).forUpdate().executeTakeFirst()
      if(!event)throw new EventDayConflictError('Event does not exist')
      if(event.status==='cancelled'||event.status==='completed')throw new EventDayConflictError(`Cannot start Event Day from event status ${event.status}`)

      await trx.insertInto('event_day_sessions').values({
        id:input.session.id,organization_id:input.session.organizationId,event_id:input.session.eventId,status:'active',
        started_at:input.session.startedAt,completed_at:null,started_by_sender:input.session.startedBySender,completed_by_sender:null,
        created_at:input.session.createdAt,updated_at:input.session.updatedAt,
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
      const session=await trx.selectFrom('event_day_sessions').selectAll()
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).forUpdate().executeTakeFirst()
      if(!session)throw new EventDayConflictError('Event Day has not been started')
      if(session.status==='completed')return{duplicate:true}
      await trx.updateTable('event_day_sessions').set({status:'completed',completed_at:input.at,completed_by_sender:input.sender,updated_at:input.at})
        .where('organization_id','=',input.organizationId).where('event_id','=',input.eventId).execute()
      await trx.updateTable('events').set({status:'completed',updated_at:input.at})
        .where('organization_id','=',input.organizationId).where('id','=',input.eventId).execute()
      await insertActivity(trx,input.activity)
      await insertOutbox(trx,input.domainEvent)
      return{duplicate:false}
    })
  }
}

async function requireActiveSession(trx:Transaction<DatabaseSchema>,organizationId:string,eventId:string):Promise<EventDaySession>{
  const row=await trx.selectFrom('event_day_sessions').selectAll().where('organization_id','=',organizationId).where('event_id','=',eventId).forUpdate().executeTakeFirst()
  if(!row)throw new EventDayConflictError('Event Day has not been started')
  if(row.status!=='active')throw new EventDayConflictError('Event Day is already completed')
  return mapSession(row)
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
  id:row.id,organizationId:row.organization_id,eventId:row.event_id,status:row.status,startedAt:row.started_at,completedAt:row.completed_at,
  startedBySender:row.started_by_sender,completedBySender:row.completed_by_sender,createdAt:row.created_at,updatedAt:row.updated_at,
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
