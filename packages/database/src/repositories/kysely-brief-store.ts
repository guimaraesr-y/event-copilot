import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import type {
  BriefPreference,
  BriefStore,
  DailyBrief,
  DailyBriefSnapshot,
  DomainEvent,
  PersistDailyBriefInput,
  ScheduledBriefPreference,
} from '@ecc/domain'
import type { DatabaseSchema, DailyBriefsTable, OrganizationBriefPreferencesTable } from '../db-types.ts'

export class KyselyBriefStore implements BriefStore {
  constructor(private readonly db:Kysely<DatabaseSchema>){}

  async getPreference(organizationId:string):Promise<BriefPreference>{
    const existing=await this.db.selectFrom('organization_brief_preferences').selectAll().where('organization_id','=',organizationId).executeTakeFirst()
    if(existing)return mapPreference(existing)
    const now=new Date()
    const row=await this.db.insertInto('organization_brief_preferences').values({
      organization_id:organizationId,enabled:false,local_time:'08:00',channel:'whatsapp',recipient:null,updated_by_sender:null,created_at:now,updated_at:now,
    }).onConflict(oc=>oc.column('organization_id').doNothing()).returningAll().executeTakeFirst()
    if(row)return mapPreference(row)
    return mapPreference(await this.db.selectFrom('organization_brief_preferences').selectAll().where('organization_id','=',organizationId).executeTakeFirstOrThrow())
  }

  async updatePreference(input:{organizationId:string;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;at:Date}):Promise<BriefPreference>{
    return this.db.transaction().execute(async trx=>{
      await sql`select pg_advisory_xact_lock(hashtext(${`brief-preference:${input.organizationId}`}))`.execute(trx)
      let row=await trx.selectFrom('organization_brief_preferences').selectAll().where('organization_id','=',input.organizationId).forUpdate().executeTakeFirst()
      if(!row){
        row=await trx.insertInto('organization_brief_preferences').values({organization_id:input.organizationId,enabled:false,local_time:'08:00',channel:'whatsapp',recipient:null,updated_by_sender:null,created_at:input.at,updated_at:input.at}).returningAll().executeTakeFirstOrThrow()
      }
      const enabled=input.enabled??row.enabled
      const recipient=input.recipient!==undefined?input.recipient:row.recipient
      const updated=await trx.updateTable('organization_brief_preferences').set({
        enabled,local_time:input.localTime??row.local_time,recipient,updated_by_sender:input.updatedBySender,updated_at:input.at,
      }).where('organization_id','=',input.organizationId).returningAll().executeTakeFirstOrThrow()
      return mapPreference(updated)
    })
  }

  async listScheduledPreferences():Promise<ScheduledBriefPreference[]>{
    const rows=await this.db.selectFrom('organization_brief_preferences as p')
      .innerJoin('organizations as o','o.id','p.organization_id')
      .select(['p.organization_id','p.enabled','p.local_time','p.channel','p.recipient','p.updated_by_sender','p.created_at','p.updated_at','o.name as organization_name','o.timezone'])
      .where('p.enabled','=',true).where('p.recipient','is not',null).execute()
    return rows.map(row=>({organizationId:row.organization_id,enabled:row.enabled,localTime:row.local_time,channel:row.channel,recipient:row.recipient,updatedBySender:row.updated_by_sender,createdAt:row.created_at,updatedAt:row.updated_at,organizationName:row.organization_name,timezone:row.timezone}))
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

  async persistDaily(input:PersistDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>{
    return this.db.transaction().execute(async trx=>{
      await sql`select pg_advisory_xact_lock(hashtext(${`daily-brief:${input.brief.organizationId}:${input.brief.referenceDate}`}))`.execute(trx)
      const existing=await trx.selectFrom('daily_briefs').selectAll().where('organization_id','=',input.brief.organizationId).where('trigger_key','=',input.brief.triggerKey).executeTakeFirst()
      if(existing)return{brief:mapBrief(existing),duplicate:true}
      const latest=await trx.selectFrom('daily_briefs').select(['revision']).where('organization_id','=',input.brief.organizationId).where('brief_type','=','daily').where('reference_date','=',input.brief.referenceDate).orderBy('revision','desc').limit(1).executeTakeFirst()
      const revision=(latest?.revision??0)+1
      await trx.updateTable('daily_briefs').set({status:'superseded',superseded_at:input.brief.generatedAt})
        .where('organization_id','=',input.brief.organizationId).where('brief_type','=','daily').where('reference_date','=',input.brief.referenceDate).where('status','=','generated').execute()
      const row=await trx.insertInto('daily_briefs').values({
        id:input.brief.id,organization_id:input.brief.organizationId,brief_type:'daily',reference_date:input.brief.referenceDate,revision,status:'generated',trigger_type:input.brief.triggerType,trigger_key:input.brief.triggerKey,summary:input.brief.summary,rendered_text:input.brief.renderedText,generated_by_sender:input.brief.generatedBySender,generated_at:input.brief.generatedAt,superseded_at:null,delivery_requested_at:input.requestDelivery?input.brief.generatedAt:null,
      }).returningAll().executeTakeFirstOrThrow()
      if(input.requestDelivery&&input.domainEvent){await insertOutbox(trx,input.domainEvent)}
      return{brief:mapBrief(row),duplicate:false}
    })
  }

  async getLatestDaily(organizationId:string,referenceDate:string):Promise<DailyBrief|null>{
    const row=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('brief_type','=','daily').where('reference_date','=',referenceDate).where('status','=','generated').orderBy('revision','desc').limit(1).executeTakeFirst()
    return row?mapBrief(row):null
  }
  async getById(organizationId:string,briefId:string):Promise<DailyBrief|null>{const row=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('id','=',briefId).executeTakeFirst();return row?mapBrief(row):null}
  async listDaily(organizationId:string,limit=30):Promise<DailyBrief[]>{const rows=await this.db.selectFrom('daily_briefs').selectAll().where('organization_id','=',organizationId).where('brief_type','=','daily').orderBy('generated_at','desc').limit(clamp(limit)).execute();return rows.map(mapBrief)}
}

function mapPreference(row:Selectable<OrganizationBriefPreferencesTable>):BriefPreference{return{organizationId:row.organization_id,enabled:row.enabled,localTime:row.local_time,channel:row.channel,recipient:row.recipient,updatedBySender:row.updated_by_sender,createdAt:row.created_at,updatedAt:row.updated_at}}
function mapBrief(row:Selectable<DailyBriefsTable>):DailyBrief{return{id:row.id,organizationId:row.organization_id,type:'daily',referenceDate:row.reference_date,revision:row.revision,status:row.status,triggerType:row.trigger_type,triggerKey:row.trigger_key,summary:row.summary,renderedText:row.rendered_text,generatedBySender:row.generated_by_sender,generatedAt:row.generated_at,supersededAt:row.superseded_at,deliveryRequestedAt:row.delivery_requested_at}}
async function insertOutbox(trx:Transaction<DatabaseSchema>,event:DomainEvent):Promise<void>{await trx.insertInto('outbox_events').values({id:event.id,organization_id:event.organizationId,event_type:event.eventType,aggregate_type:event.aggregateType,aggregate_id:event.aggregateId,payload:event.payload,occurred_at:event.occurredAt,available_at:event.occurredAt,claimed_at:null,claimed_by:null,dispatched_at:null,last_error:null}).execute()}
function clamp(value:number|undefined):number{if(!value||!Number.isInteger(value)||value<1)return 30;return Math.min(value,100)}
