import type { BriefPreference, BriefSchedule, BriefStore, DailyBrief, DailyBriefSnapshot, PersistDailyBriefInput, PersistDMinus1BriefInput, ScheduledBriefSchedule, DMinus1Brief, DMinus1BriefSnapshot } from '../../packages/domain/src/index.ts'
import { BriefEngine } from '../../packages/event-engine/src/brief-engine.ts'

function assert(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(`Assertion failed: ${msg}`)}
const ORG='11111111-1111-4111-8111-111111111111'
const EVENT='22222222-2222-4222-8222-222222222222'
const fixed=new Date('2026-08-19T10:31:00.000Z') // 07:31 America/Sao_Paulo
const snapshot:DailyBriefSnapshot={
  organizationId:ORG,organizationName:'Cerimonial XPTO',timezone:'America/Sao_Paulo',
  events:[{id:EVENT,name:'Ana & Pedro',startAt:new Date('2026-10-17T20:00:00Z'),status:'planning',healthScore:69}],
  tasks:[
    {id:'task-overdue',eventId:EVENT,title:'Confirmar transporte',status:'pending',priority:'high',dueAt:new Date('2026-08-18T13:00:00Z')},
    {id:'task-today',eventId:EVENT,title:'Fechar lista',status:'pending',priority:'normal',dueAt:new Date('2026-08-19T15:00:00Z')},
  ],
  vendors:[{id:'vendor-pending',eventId:EVENT,vendorName:'Buffet Luz',confirmationStatus:'requested'}],
  risks:[{id:'risk-1',eventId:EVENT,severity:'critical',score:92,title:'Buffet ainda não confirmou',description:'Evento próximo com confirmação pendente',status:'open'}],
  dependencies:[{id:'dep-1',eventId:EVENT,severity:'warning',title:'Revisar horário do fotógrafo'}],
  changes:[{id:'change-1',eventId:EVENT,type:'event_time'}],
  inbox:[{id:'inbox-1',eventId:EVENT,severity:'critical',title:'Fornecedor pendente'}],
}

class Store implements BriefStore{
  dailySchedule:BriefSchedule={organizationId:ORG,type:'daily',enabled:false,localTime:'08:00',channel:'whatsapp',recipient:null,updatedBySender:null,createdAt:fixed,updatedAt:fixed}
  d1Schedule:BriefSchedule={organizationId:ORG,type:'d_minus_1',enabled:false,localTime:'18:00',channel:'whatsapp',recipient:null,updatedBySender:null,createdAt:fixed,updatedAt:fixed}
  scheduledSchedules:ScheduledBriefSchedule[]=[]
  briefs:DailyBrief[]=[]
  d1Briefs:DMinus1Brief[]=[]
  outbox:any[]=[]
  async getPreference():Promise<BriefPreference>{const{type:_type,...pref}=this.dailySchedule;return pref}
  async updatePreference(input:any){this.dailySchedule={...this.dailySchedule,...('enabled'in input?{enabled:input.enabled}:{}),...('localTime'in input&&input.localTime?{localTime:input.localTime}:{}),...('recipient'in input?{recipient:input.recipient}:{}),updatedBySender:input.updatedBySender,updatedAt:input.at};return this.getPreference()}
  async listScheduledPreferences(){return this.scheduledSchedules.filter(x=>x.type==='daily').map(({type:_type,...x})=>x)}
  async getSchedule(_o:string,type:'daily'|'d_minus_1'){return type==='daily'?this.dailySchedule:this.d1Schedule}
  async updateSchedule(input:any){const key=input.type==='daily'?'dailySchedule':'d1Schedule';(this as any)[key]={...(this as any)[key],...('enabled'in input?{enabled:input.enabled}:{}),...('localTime'in input&&input.localTime?{localTime:input.localTime}:{}),...('recipient'in input?{recipient:input.recipient}:{}),updatedBySender:input.updatedBySender,updatedAt:input.at};return (this as any)[key]}
  async listScheduledSchedules(){return this.scheduledSchedules}
  async loadDailySnapshot(o:string){return o===ORG?structuredClone(snapshot):null}
  async loadDMinus1Snapshot(_o:string,_e:string):Promise<DMinus1BriefSnapshot|null>{return null}
  async persistDaily(input:PersistDailyBriefInput){const old=this.briefs.find(b=>b.organizationId===input.brief.organizationId&&b.triggerKey===input.brief.triggerKey);if(old)return{brief:old,duplicate:true};for(const b of this.briefs)if(b.organizationId===input.brief.organizationId&&b.referenceDate===input.brief.referenceDate&&b.status==='generated'){b.status='superseded';b.supersededAt=input.brief.generatedAt}const revision=Math.max(0,...this.briefs.filter(b=>b.referenceDate===input.brief.referenceDate).map(b=>b.revision))+1;const brief:DailyBrief={...input.brief,revision,status:'generated',supersededAt:null};this.briefs.push(brief);if(input.requestDelivery&&input.domainEvent)this.outbox.push(input.domainEvent);return{brief,duplicate:false}}
  async persistDMinus1(_input:PersistDMinus1BriefInput):Promise<{brief:DMinus1Brief;duplicate:boolean}>{throw new Error('not used')}
  async getLatestDaily(o:string,d:string){return [...this.briefs].filter(b=>b.organizationId===o&&b.referenceDate===d&&b.status==='generated').sort((a,b)=>b.revision-a.revision)[0]??null}
  async getLatestDMinus1(){return null}
  async getById(o:string,id:string){return this.briefs.find(b=>b.organizationId===o&&b.id===id)??this.d1Briefs.find(b=>b.organizationId===o&&b.id===id)??null}
  async listDaily(o:string,limit=30){return this.briefs.filter(b=>b.organizationId===o).sort((a,b)=>b.generatedAt.getTime()-a.generatedAt.getTime()).slice(0,limit)}
  async listDMinus1(){return this.d1Briefs}
}

const store=new Store();let seq=0
const engine=new BriefEngine({store,now:()=>fixed,newId:()=>`33333333-3333-4333-8333-${String(++seq).padStart(12,'0')}`})
let checks=0

let result=await engine.generateDaily({organizationId:ORG,triggerType:'manual',triggerKey:'manual:first'})
assert(result.brief.eventId===null,'daily brief is workspace-scoped');checks++
assert(result.brief.referenceDate==='2026-08-19','reference date uses organization timezone');checks++
assert(result.brief.summary.overdueTasks===1&&result.brief.summary.dueTodayTasks===1,'brief separates overdue and due-today tasks');checks++
assert(result.brief.summary.pendingVendors===1&&result.brief.summary.openDependencies===1&&result.brief.summary.pendingChanges===1,'brief summarizes vendor/dependency/change state');checks++
assert(result.brief.summary.events[0]?.healthScore===69&&result.brief.summary.events[0]?.healthStatus==='attention','event health is embedded in brief');checks++
assert(result.brief.summary.priorities[0]?.type==='risk'&&result.brief.summary.priorities[0]?.score===92,'highest operational risk ranks first');checks++
assert(result.brief.renderedText.includes('Prioridades de hoje')&&result.brief.renderedText.includes('Buffet ainda não confirmou'),'deterministic morning text contains priorities');checks++

const dup=await engine.generateDaily({organizationId:ORG,triggerType:'manual',triggerKey:'manual:first'})
assert(dup.duplicate&&dup.brief.id===result.brief.id,'same generation trigger is idempotent');checks++
const revision=await engine.generateDaily({organizationId:ORG,triggerType:'manual',triggerKey:'manual:second'})
assert(revision.brief.revision===2&&result.brief.status==='superseded','fresh trigger creates revision and supersedes previous brief');checks++
assert((await engine.getToday(ORG)).id===revision.brief.id,'getToday returns current revision');checks++
assert((await engine.list(ORG,10)).length===2,'brief history preserves revisions');checks++

const pref=await engine.getPreference(ORG);assert(!pref.enabled&&pref.localTime==='08:00','daily brief schedule is opt-in with 08:00 default');checks++
let rejected=false;try{await engine.configurePreference({organizationId:ORG,enabled:true,updatedBySender:'cli'})}catch{rejected=true}assert(rejected,'enabling schedule without phone is rejected');checks++
const configured=await engine.configurePreference({organizationId:ORG,enabled:true,localTime:'07:30',updatedBySender:'planner',fallbackRecipient:'+55 (21) 99999-9999'})
assert(configured.enabled&&configured.localTime==='07:30'&&configured.recipient==='5521999999999','agent sender can become configured WhatsApp recipient');checks++

store.scheduledSchedules=[{...store.dailySchedule,organizationName:'Cerimonial XPTO',timezone:'America/Sao_Paulo'}]
const scheduled=await engine.processDueSchedules(fixed)
assert(scheduled.generated===1&&scheduled.daily===1&&store.outbox.at(-1)?.eventType==='brief.delivery_requested','due scheduler generates brief and durable delivery request');checks++
assert(store.outbox.at(-1)?.payload.source==='brief_engine'&&store.outbox.at(-1)?.payload.recipient==='5521999999999','scheduled delivery identifies brief engine source and configured recipient');checks++
const retry=await engine.processDueSchedules(new Date('2026-08-19T11:00:00Z'))
assert(retry.duplicates===1&&store.outbox.filter(e=>e.eventType==='brief.delivery_requested').length===1,'scheduler retry does not request duplicate morning message');checks++
const beforeTomorrow=await engine.processDueSchedules(new Date('2026-08-20T10:29:00Z'))
assert(beforeTomorrow.generated===0&&beforeTomorrow.duplicates===0,'scheduler does not send before configured local time');checks++
const tomorrow=await engine.processDueSchedules(new Date('2026-08-20T10:30:00Z'))
assert(tomorrow.generated===1&&store.outbox.length===2,'scheduler produces one new delivery on next local day');checks++

console.log(`BriefEngine: ${checks}/${checks} behavioral scenarios passed`)
