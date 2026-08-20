import type { BriefPreference, BriefSchedule, BriefStore, DailyBrief, DailyBriefSnapshot, DMinus1Brief, DMinus1BriefSnapshot, PersistDailyBriefInput, PersistDMinus1BriefInput, ScheduledBriefSchedule } from '../../packages/domain/src/index.ts'
import { BriefEngine, buildDMinus1Summary } from '../../packages/event-engine/src/brief-engine.ts'

function assert(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(`Assertion failed: ${msg}`)}
const ORG='11111111-1111-4111-8111-111111111111'
const EVENT='22222222-2222-4222-8222-222222222222'
const fixed=new Date('2026-08-19T21:31:00.000Z') // 18:31 America/Sao_Paulo
const eventStart=new Date('2026-08-20T20:00:00.000Z') // 17:00 local

const dailySnapshot:DailyBriefSnapshot={organizationId:ORG,organizationName:'Cerimonial XPTO',timezone:'America/Sao_Paulo',events:[{id:EVENT,name:'Ana & Pedro',startAt:eventStart,status:'planning',healthScore:61}],tasks:[],vendors:[],risks:[],dependencies:[],changes:[],inbox:[]}
const d1Snapshot:DMinus1BriefSnapshot={
  organizationId:ORG,organizationName:'Cerimonial XPTO',timezone:'America/Sao_Paulo',
  event:{id:EVENT,name:'Ana & Pedro',startAt:eventStart,endAt:new Date('2026-08-21T02:00:00Z'),status:'planning',healthScore:61,venueName:'Casa do Lago',venueAddress:'Rua das Flores, 10',guestCount:150},
  tasks:[
    {id:'task-critical',title:'Confirmar transporte dos noivos',status:'pending',priority:'critical',dueAt:new Date('2026-08-19T18:00:00Z')},
    {id:'task-normal',title:'Separar kit emergência',status:'pending',priority:'normal',dueAt:new Date('2026-08-20T12:00:00Z')},
  ],
  milestones:[{id:'milestone-1',name:'Briefing equipe',status:'pending',dueAt:new Date('2026-08-19T20:00:00Z')}],
  vendors:[
    {id:'vendor-1',vendorName:'Buffet Luz',category:'buffet',confirmationStatus:'confirmed',arrivalAt:new Date('2026-08-20T17:00:00Z'),departureAt:new Date('2026-08-21T01:00:00Z')},
    {id:'vendor-2',vendorName:'Foto Clara',category:'photo',confirmationStatus:'requested',arrivalAt:new Date('2026-08-20T18:00:00Z'),departureAt:null},
  ],
  risks:[{id:'risk-1',severity:'high',score:82,title:'Fotógrafo aguardando confirmação',description:'Confirmação pendente',status:'open'}],
  dependencies:[{id:'dep-1',severity:'warning',title:'Revisar horário do fotógrafo'}],
  changes:[],
  inbox:[{id:'inbox-1',severity:'warning',title:'Fornecedor pendente'}],
}

class Store implements BriefStore{
  daily:BriefSchedule={organizationId:ORG,type:'daily',enabled:true,localTime:'07:30',channel:'whatsapp',recipient:'5521991111111',updatedBySender:'planner',createdAt:fixed,updatedAt:fixed}
  d1:BriefSchedule={organizationId:ORG,type:'d_minus_1',enabled:false,localTime:'18:00',channel:'whatsapp',recipient:null,updatedBySender:null,createdAt:fixed,updatedAt:fixed}
  scheduled:ScheduledBriefSchedule[]=[]
  d1Snapshot:DMinus1BriefSnapshot=structuredClone(d1Snapshot)
  d1Briefs:DMinus1Brief[]=[]
  outbox:any[]=[]
  async getPreference():Promise<BriefPreference>{const{type:_type,...x}=this.daily;return x}
  async updatePreference(input:any){this.daily={...this.daily,...input,type:'daily'};const{type:_type,...x}=this.daily;return x}
  async listScheduledPreferences(){return this.scheduled.filter(x=>x.type==='daily').map(({type:_type,...x})=>x)}
  async getSchedule(_o:string,type:'daily'|'d_minus_1'){return type==='daily'?this.daily:this.d1}
  async updateSchedule(input:any){const key=input.type==='daily'?'daily':'d1';const old=(this as any)[key];(this as any)[key]={...old,...('enabled'in input?{enabled:input.enabled}:{}),...('localTime'in input&&input.localTime?{localTime:input.localTime}:{}),...('recipient'in input?{recipient:input.recipient}:{}),updatedBySender:input.updatedBySender,updatedAt:input.at};return (this as any)[key]}
  async listScheduledSchedules(){return this.scheduled}
  async loadDailySnapshot(){return structuredClone(dailySnapshot)}
  async loadDMinus1Snapshot(o:string,e:string){return o===ORG&&e===EVENT?structuredClone(this.d1Snapshot):null}
  async persistDaily(_input:PersistDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>{throw new Error('not used')}
  async persistDMinus1(input:PersistDMinus1BriefInput){const existing=this.d1Briefs.find(b=>b.triggerKey===input.brief.triggerKey);if(existing)return{brief:existing,duplicate:true};for(const b of this.d1Briefs.filter(b=>b.eventId===input.brief.eventId&&b.status==='generated')){b.status='superseded';b.supersededAt=input.brief.generatedAt}const revision=Math.max(0,...this.d1Briefs.filter(b=>b.eventId===input.brief.eventId&&b.referenceDate===input.brief.referenceDate).map(b=>b.revision))+1;const brief:DMinus1Brief={...input.brief,revision,status:'generated',supersededAt:null};this.d1Briefs.push(brief);if(input.requestDelivery&&input.domainEvent)this.outbox.push(input.domainEvent);return{brief,duplicate:false}}
  async getLatestDaily(){return null as DailyBrief|null}
  async getLatestDMinus1(_o:string,e:string){return [...this.d1Briefs].filter(b=>b.eventId===e&&b.status==='generated').at(-1)??null}
  async getById(_o:string,id:string){return this.d1Briefs.find(b=>b.id===id)??null}
  async listDaily(){return []}
  async listDMinus1(_o:string,eventId?:string,limit=30){return this.d1Briefs.filter(b=>!eventId||b.eventId===eventId).slice(-limit).reverse()}
}

let seq=0;const store=new Store();const engine=new BriefEngine({store,now:()=>fixed,newId:()=>`33333333-3333-4333-8333-${String(++seq).padStart(12,'0')}`})
let checks=0

const generated=await engine.generateDMinus1({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:d1'})
assert(generated.brief.type==='d_minus_1'&&generated.brief.eventId===EVENT,'D-1 brief is event-scoped');checks++
assert(generated.brief.summary.readiness==='NOT_READY','critical open task makes D-1 NOT_READY');checks++
assert(generated.brief.summary.readinessReasons.some(x=>x.includes('tarefa(s) crítica')), 'readiness explains blocking reason');checks++
assert(generated.brief.summary.counts.pendingVendors===1&&generated.brief.summary.counts.confirmedVendors===1,'D-1 counts vendor readiness');checks++
assert(generated.brief.summary.timeline[0]?.title.includes('Buffet Luz')&&generated.brief.summary.timeline.some(x=>x.type==='event_start'),'timeline includes vendor arrival and event start');checks++
assert(generated.brief.renderedText.includes('Briefing D-1')&&generated.brief.renderedText.includes('NÃO PRONTO'),'rendered D-1 text exposes deterministic readiness');checks++

const duplicate=await engine.generateDMinus1({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:d1'})
assert(duplicate.duplicate&&duplicate.brief.id===generated.brief.id,'D-1 generation is idempotent by trigger');checks++
const second=await engine.generateDMinus1({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:d1:2'})
assert(second.brief.revision===2&&generated.brief.status==='superseded','new D-1 generation creates revision and preserves history');checks++
assert((await engine.getDMinus1(ORG,EVENT)).id===second.brief.id,'getDMinus1 returns latest generated revision');checks++

const defaultSchedule=await engine.getSchedule(ORG,'d_minus_1')
assert(!defaultSchedule.enabled&&defaultSchedule.localTime==='18:00','D-1 schedule defaults to disabled at 18:00');checks++
assert((await engine.getPreference(ORG)).localTime==='07:30','D-1 schedule is independent from Daily Brief schedule');checks++
const configured=await engine.configureSchedule({organizationId:ORG,type:'d_minus_1',enabled:true,localTime:'18:30',updatedBySender:'planner',fallbackRecipient:'+55 21 98888-7777'})
assert(configured.enabled&&configured.localTime==='18:30'&&configured.recipient==='5521988887777','D-1 schedule supports independent WhatsApp delivery');checks++

store.scheduled=[{...store.d1,organizationName:'Cerimonial XPTO',timezone:'America/Sao_Paulo'}]
const scheduled=await engine.processDueSchedules(fixed)
assert(scheduled.generated===1&&scheduled.dMinus1===1,'scheduler generates D-1 for events occurring tomorrow in organization timezone');checks++
assert(store.outbox.at(-1)?.payload.messageType==='d_minus_1_brief'&&store.outbox.at(-1)?.payload.eventId===EVENT,'scheduled D-1 creates durable event-scoped delivery request');checks++
const retry=await engine.processDueSchedules(new Date('2026-08-19T22:00:00Z'))
assert(retry.duplicates===1&&store.outbox.length===1,'D-1 scheduler retry does not duplicate WhatsApp delivery');checks++

const warningSnapshot=structuredClone(d1Snapshot);warningSnapshot.tasks=warningSnapshot.tasks.filter(t=>t.priority!=='critical')
const warning=buildDMinus1Summary(warningSnapshot,'2026-08-19',fixed)
assert(warning.readiness==='READY_WITH_WARNINGS','non-blocking D-1 issues produce READY_WITH_WARNINGS');checks++
const readySnapshot=structuredClone(d1Snapshot);readySnapshot.tasks=[];readySnapshot.milestones=[];readySnapshot.vendors=readySnapshot.vendors.map(v=>({...v,confirmationStatus:'confirmed'}));readySnapshot.risks=[];readySnapshot.dependencies=[];readySnapshot.changes=[];readySnapshot.inbox=[]
const ready=buildDMinus1Summary(readySnapshot,'2026-08-19',fixed)
assert(ready.readiness==='READY'&&ready.readinessReasons.length===0,'clean D-1 snapshot is READY');checks++

console.log(`DMinus1BriefEngine: ${checks}/${checks} behavioral scenarios passed`)
