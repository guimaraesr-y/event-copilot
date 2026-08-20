import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import type {
  BriefPreference,
  BriefSchedule,
  BriefStore,
  BriefType,
  DailyBrief,
  DailyBriefSnapshot,
  DMinus1Brief,
  DMinus1BriefSnapshot,
  DomainEvent,
  OperationalBrief,
  PersistDailyBriefInput,
  PersistDMinus1BriefInput,
  ScheduledBriefPreference,
  ScheduledBriefSchedule,
} from '@ecc/domain'
import type {
  DatabaseSchema,
  DailyBriefsTable,
  OrganizationBriefPreferencesTable,
  OrganizationBriefSchedulesTable,
} from '../db-types.ts'

export class KyselyBriefStore implements BriefStore {
  constructor(private readonly db:Kysely<DatabaseSchema>){}

  async getPreference(organizationId:string):Promise<BriefPreference>{
    const schedule=await this.getSchedule(organizationId,'daily')
    return withoutType(schedule)
  }

  async updatePreference(input:{organizationId:string;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;at:Date}):Promise<BriefPreference>{
    const schedule=await this.updateSchedule({...input,type:'daily'})
    await this.syncLegacyDailyPreference(schedule,input.at)
    return withoutType(schedule)
  }

  async listScheduledPreferences():Promise<ScheduledBriefPreference[]>{
    return (await this.listScheduledSchedules('daily')).map(({type:_type,...row})=>row)
  }

  async getSchedule(organizationId:string,type:BriefType):Promise<BriefSchedule>{
    const existing=await this.db.selectFrom('organization_brief_schedules').selectAll().where('organization_id','=',organizationId).where('brief_type','=',type).executeTakeFirst()
    if(existing)return mapSchedule(existing)
    const now=new Date();const defaultTime=type==='daily'?'08:00':'18:00'
    const row=await this.db.insertInto('organization_brief_schedules').values({
      organization_id:organizationId,brief_type:type,enabled:false,local_time:defaultTime,channel:'whatsapp',recipient:null,updated_by_sender:null,created_at:now,updated_at:now,
    }).onConflict(oc=>oc.columns(['organization_id','brief_type']).doNothing()).returningAll().executeTakeFirst()
    if(row)return mapSchedule(row)
    return mapSchedule(await this.db.selectFrom('organization_brief_schedules').selectAll().where('organization_id','=',organizationId).where('brief_type','=',type).executeTakeFirstOrThrow())
  }

  async updateSchedule(input:{organizationId:string;type:BriefType;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;at:Date}):Promise<BriefSchedule>{
    return this.db.transaction().execute(async trx=>{
      await sql`select pg_advisory_xact_lock(hashtext(${`brief-schedule:${input.organizationId}:${input.type}`}))`.execute(trx)
      let row=await trx.selectFrom('organization_brief_schedules').selectAll().where('organization_id','=',input.organizationId).where('brief_type','=',input.type).forUpdate().executeTakeFirst()
      if(!row){
        row=await trx.insertInto('organization_brief_schedules').values({organization_id:input.organizationId,brief_type:input.type,enabled:false,local_time:input.type==='daily'?'08:00':'18:00',channel:'whatsapp',recipient:null,updated_by_sender:null,created_at:input.at,updated_at:input.at}).returningAll().executeTakeFirstOrThrow()
      }
      const enabled=input.enabled??row.enabled
      const recipient=input.recipient!==undefined?input.recipient:row.recipient
      const updated=await trx.updateTable('organization_brief_schedules').set({
        enabled,local_time:input.localTime??row.local_time,recipient,updated_by_sender:input.updatedBySender,updated_at:input.at,
      }).where('organization_id','=',input.organizationId).where('brief_type','=',input.type).returningAll().executeTakeFirstOrThrow()
      return mapSchedule(updated)
    })
  }

  async listScheduledSchedules(type?:BriefType):Promise<ScheduledBriefSchedule[]>{
    let query=this.db.selectFrom('organization_brief_schedules as p')
      .innerJoin('organizations as o','o.id','p.organization_id')
      .select(['p.organization_id','p.brief_type','p.enabled','p.local_time','p.channel','p.recipient','p.updated_by_sender','p.created_at','p.updated_at','o.name as organization_name','o.timezone'])
      .where('p.enabled','=',true).where('p.recipient','is not',null)
    if(type)query=query.where('p.brief_type','=',type)
    const rows=await query.execute()
    return rows.map(row=>({organizationId:row.organization_id,type:row.brief_type,enabled:row.enabled,localTime:row.local_time,channel:row.channel,recipient:row.recipient,updatedBySender:row.updated_by_sender,createdAt:row.created_at,updatedAt:row.updated_at,organizationName:row.organization_name,timezone:row.timezone}))
  }

  async loadDailySnapshot(organizationId:string):Promise<DailyBriefSnapshot|null>{
    const organization=await this.db.selectFrom('organizations').select(['id','name','timezone']).where('id','=',organizationId).executeTakeFirst()
    if(!organization)return null
    const events=await this.db.selectFrom('events').select(['id','name','start_at','status','health_score'])
      .where('organization_id','=',organizationId).where('status','not in',['completed','cancelled']).orderBy('start_at','asc').execute()
    const ids=events.map(e=>e.id)
    if(!ids.length)return{organizationId,organizationName:organization.name,timezone:organization.timezone,events:[],tasks:[],vendors:[],risks:[],dependencies:[],changes:[],inbox:[]}
    const [tasks,vendors,risks,dependencies,changes,inbox]=await Promise.all([
      this.db.selectFrom('event_tasks').select(['id','event_id','title','status','priority','due_at']).where('organization_id','=',organizationId).where('event_id','in',ids).where('status','in',['pending','in_progress']).execute(),
      this.db.selectFrom('event_vendors').select(['id','event_id','vendor_name','confirmation_status']).where('organization_id','=',organizationId).where('event_id','in',ids).where('confirmation_status','in',['pending','requested','declined']).execute(),
      this.db.selectFrom('event_risks').select(['id','event_id','severity','score','title','description','status']).where('organization_id','=',organizationId).where('event_id','in',ids).where('status','in',['open','acknowledged']).execute(),
      this.db.selectFrom('dependency_impacts').select(['id','event_id','severity','title']).where('organization_id','=',organizationId).where('event_id','in',ids).where('status','=','open').execute(),
      this.db.selectFrom('change_proposals').select(['id','event_id','type']).where('organization_id','=',organizationId).where('event_id','in',ids).where('status','=','proposed').execute(),
      this.db.selectFrom('inbox_items').select(['id','event_id','severity','title']).where('organization_id','=',organizationId).where('status','in',['open','in_progress']).execute(),
    ])
    return{
      organizationId,organizationName:organization.name,timezone:organization.timezone,
      events:events.map(e=>({id:e.id,name:e.name,startAt:e.start_at,status:e.status,healthScore:e.health_score})),
      tasks:tasks.map(t=>({id:t.id,eventId:t.event_id,title:t.title,status:t.status,priority:t.priority,dueAt:t.due_at})),
      vendors:vendors.map(v=>({id:v.id,eventId:v.event_id,vendorName:v.vendor_name,confirmationStatus:v.confirmation_status})),
      risks:risks.map(r=>({id:r.id,eventId:r.event_id,severity:r.severity,score:r.score,title:r.title,description:r.description,status:r.status as 'open'|'acknowledged'})),
      dependencies:dependencies.map(d=>({id:d.id,eventId:d.event_id,severity:d.severity,title:d.title})),
      changes:changes.map(c=>({id:c.id,eventId:c.event_id,type:c.type})),
      inbox:inbox.map(i=>({id:i.id,eventId:i.event_id,severity:i.severity,title:i.title})),
    }
  }

  async loadDMinus1Snapshot(organizationId:string,eventId:string):Promise<DMinus1BriefSnapshot|null>{
    const organization=await this.db.selectFrom('organizations').select(['id','name','timezone']).where('id','=',organizationId).executeTakeFirst()
    if(!organization)return null
    const event=await this.db.selectFrom('events').select(['id','name','start_at','end_at','status','health_score','venue_name','venue_address','guest_count'])
      .where('organization_id','=',organizationId).where('id','=',eventId).where('status','not in',['completed','cancelled']).executeTakeFirst()
    if(!event)return null
    const [tasks,milestones,vendors,risks,dependencies,changes,inbox]=await Promise.all([
      this.db.selectFrom('event_tasks').select(['id','title','status','priority','due_at']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','in',['pending','in_progress']).execute(),
      this.db.selectFrom('event_milestones').select(['id','name','status','due_at']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','in',['pending','missed']).execute(),
      this.db.selectFrom('event_vendors').select(['id','vendor_name','category','confirmation_status','arrival_at','departure_at']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('confirmation_status','!=','cancelled').execute(),
      this.db.selectFrom('event_risks').select(['id','severity','score','title','description','status']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','in',['open','acknowledged']).execute(),
      this.db.selectFrom('dependency_impacts').select(['id','severity','title']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','=','open').execute(),
      this.db.selectFrom('change_proposals').select(['id','type']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','=','proposed').execute(),
      this.db.selectFrom('inbox_items').select(['id','severity','title']).where('organization_id','=',organizationId).where('event_id','=',eventId).where('status','in',['open','in_progress']).execute(),
    ])
    return{
      organizationId,organizationName:organization.name,timezone:organization.timezone,
      event:{id:event.id,name:event.name,startAt:event.start_at,endAt:event.end_at,status:event.status,healthScore:event.health_score,venueName:event.venue_name,venueAddress:event.venue_address,guestCount:event.guest_count},
      tasks:tasks.map(t=>({id:t.id,title:t.title,status:t.status,priority:t.priority,dueAt:t.due_at})),
      milestones:milestones.map(m=>({id:m.id,name:m.name,status:m.status,dueAt:m.due_at})),
      vendors:vendors.map(v=>({id:v.id,vendorName:v.vendor_name,category:v.category,confirmationStatus:v.confirmation_status,arrivalAt:v.arrival_at,departureAt:v.departure_at})),
      risks:risks.map(r=>({id:r.id,severity:r.severity,score:r.score,title:r.title,description:r.description,status:r.status as 'open'|'acknowledged'})),
      dependencies:dependencies.map(d=>({id:d.id,severity:d.severity,title:d.title})),
      changes:changes.map(c=>({id:c.id,type:c.type})),
      inbox:inbox.map(i=>({id:i.id,severity:i.severity,title:i.title})),
    }
  }

  async persistDaily(input:PersistDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>{
    return this.persistBrief('daily',null,input.brief,input.requestDelivery,input.domainEvent) as Promise<{brief:DailyBrief;duplicate:boolean}>
  }

  async persistDMinus1(input:PersistDMinus1BriefInput):Promise<{brief:DMinus1Brief;duplicate:boolean}>{
    return this.persistBrief('d_minus_1',input.brief.eventId,input.brief,input.requestDelivery,input.domainEvent) as Promise<{brief:DMinus1Brief;duplicate:boolean}>
  }

  private async persistBrief(type:BriefType,eventId:string|null,brief:any,requestDelivery:boolean,domainEvent:DomainEvent|null):Promise<{brief:OperationalBrief;duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await sql`select pg_advisory_xact_lock(hashtext(${`brief:${brief.organizationId}:${type}:${eventId??'workspace'}:${brief.referenceDate}`}))`.execute(trx)
      const existing=await trx.selectFrom('daily_briefs').selectAll().where('organization_id','=',brief.organizationId).where('trigger_key','=',brief.triggerKey).executeTakeFirst()
      if(existing)return{brief:mapBrief(existing),duplicate:true}
      let latestQuery=trx.selectFrom('daily_briefs').select(['revision']).where('organization_id','=',brief.organizationId).where('brief_type','=',type).where('reference_date','=',brief.referenceDate)
      latestQuery=eventId?latestQuery.where('event_id','=',eventId):latestQuery.where('event_id','is',null)
      const latest=await latestQuery.orderBy('revision','desc').limit(1).executeTakeFirst()
      const revision=(latest?.revision??0)+1
      let supersede=trx.updateTable('daily_briefs').set({status:'superseded',superseded_at:brief.generatedAt}).where('organization_id','=',brief.organizationId).where('brief_type','=',type).where('status','=','generated')
      supersede=eventId?supersede.where('event_id','=',eventId):supersede.where('event_id','is',null).where('reference_date','=',brief.referenceDate)
      await supersede.execute()
      const row=await trx.insertInto('daily_briefs').values({
        id:brief.id,organization_id:brief.organizationId,brief_type:type,event_id:eventId,reference_date:brief.referenceDate,revision,status:'generated',trigger_type:brief.triggerType,trigger_key:brief.triggerKey,summary:brief.summary,rendered_text:brief.renderedText,generated_by_sender:brief.generatedBySender,generated_at:brief.generatedAt,superseded_at:null,delivery_requested_at:requestDelivery?brief.generatedAt:null,
      }).returningAll().executeTakeFirstOrThrow()
      if(requestDelivery&&domainEvent)await insertOutbox(trx,domainEvent)
      return{brief:mapBrief(row),duplicate:false}
    })
  }

  async getLatestDaily(organizationId:string,referenceDate:string):Promise<DailyBrief|null>{
    const row=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('brief_type','=','daily').where('event_id','is',null).where('reference_date','=',referenceDate).where('status','=','generated').orderBy('revision','desc').limit(1).executeTakeFirst()
    return row?mapBrief(row) as DailyBrief:null
  }
  async getLatestDMinus1(organizationId:string,eventId:string):Promise<DMinus1Brief|null>{
    const row=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('brief_type','=','d_minus_1').where('event_id','=',eventId).where('status','=','generated').orderBy('generated_at','desc').limit(1).executeTakeFirst()
    return row?mapBrief(row) as DMinus1Brief:null
  }
  async getById(organizationId:string,briefId:string):Promise<OperationalBrief|null>{const row=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('id','=',briefId).executeTakeFirst();return row?mapBrief(row):null}
  async listDaily(organizationId:string,limit=30):Promise<DailyBrief[]>{const rows=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('brief_type','=','daily').where('event_id','is',null).orderBy('generated_at','desc').limit(clamp(limit)).execute();return rows.map(row=>mapBrief(row) as DailyBrief)}
  async listDMinus1(organizationId:string,eventId?:string,limit=30):Promise<DMinus1Brief[]>{let query=this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('brief_type','=','d_minus_1');if(eventId)query=query.where('event_id','=',eventId);const rows=await query.orderBy('generated_at','desc').limit(clamp(limit)).execute();return rows.map(row=>mapBrief(row) as DMinus1Brief)}

  private async syncLegacyDailyPreference(schedule:BriefSchedule,at:Date):Promise<void>{
    await this.db.insertInto('organization_brief_preferences').values({organization_id:schedule.organizationId,enabled:schedule.enabled,local_time:schedule.localTime,channel:'whatsapp',recipient:schedule.recipient,updated_by_sender:schedule.updatedBySender,created_at:at,updated_at:at})
      .onConflict(oc=>oc.column('organization_id').doUpdateSet({enabled:schedule.enabled,local_time:schedule.localTime,recipient:schedule.recipient,updated_by_sender:schedule.updatedBySender,updated_at:at})).execute()
  }
}

function withoutType(value:BriefSchedule):BriefPreference{const{type:_type,...rest}=value;return rest}
function mapPreference(row:Selectable<OrganizationBriefPreferencesTable>):BriefPreference{return{organizationId:row.organization_id,enabled:row.enabled,localTime:row.local_time,channel:row.channel,recipient:row.recipient,updatedBySender:row.updated_by_sender,createdAt:row.created_at,updatedAt:row.updated_at}}
function mapSchedule(row:Selectable<OrganizationBriefSchedulesTable>):BriefSchedule{return{organizationId:row.organization_id,type:row.brief_type,enabled:row.enabled,localTime:row.local_time,channel:row.channel,recipient:row.recipient,updatedBySender:row.updated_by_sender,createdAt:row.created_at,updatedAt:row.updated_at}}
function mapBrief(row:Selectable<DailyBriefsTable>):OperationalBrief{
  const common={id:row.id,organizationId:row.organization_id,referenceDate:row.reference_date,revision:row.revision,status:row.status,triggerType:row.trigger_type,triggerKey:row.trigger_key,renderedText:row.rendered_text,generatedBySender:row.generated_by_sender,generatedAt:row.generated_at,supersededAt:row.superseded_at,deliveryRequestedAt:row.delivery_requested_at}
  if(row.brief_type==='d_minus_1'){
    if(!row.event_id)throw new Error(`d_minus_1 brief ${row.id} is missing event_id`)
    return{...common,type:'d_minus_1',eventId:row.event_id,summary:row.summary as import('@ecc/domain').DMinus1BriefSummary}
  }
  return{...common,type:'daily',eventId:null,summary:row.summary as import('@ecc/domain').DailyBriefSummary}
}
async function insertOutbox(trx:Transaction<DatabaseSchema>,event:DomainEvent):Promise<void>{await trx.insertInto('outbox_events').values({id:event.id,organization_id:event.organizationId,event_type:event.eventType,aggregate_type:event.aggregateType,aggregate_id:event.aggregateId,payload:event.payload,occurred_at:event.occurredAt,available_at:event.occurredAt,claimed_at:null,claimed_by:null,dispatched_at:null,last_error:null}).execute()}
function clamp(value:number|undefined):number{if(!value||!Number.isInteger(value)||value<1)return 30;return Math.min(value,100)}
