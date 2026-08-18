import type {
  ChangeProposal, ChangeProposalImpact, ChangeProposalStore, ChangeProposalWithImpacts, DomainEvent, Event, EventMilestone,
  EventStore, EventTask, EventTemplateSnapshot, EventVendor, ListChangeProposalsInput, Vendor, VendorStore,
} from '../../packages/domain/src/index.ts'
import { ChangeProposalEngine } from '../../packages/event-engine/src/change-proposal-engine.ts'
import { EventEngine } from '../../packages/event-engine/src/event-engine.ts'
import { VendorEngine } from '../../packages/event-engine/src/vendor-engine.ts'

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(`Assertion failed: ${m}`) }
const ORG='org-1'; const EVENT='11111111-1111-4111-8111-111111111111'; const fixed=new Date('2026-08-17T12:00:00Z')
let seq=0; const id=()=>`44444444-4444-4444-8444-${String(++seq).padStart(12,'0')}`
class ES implements EventStore {
  event:Event={id:EVENT,organizationId:ORG,templateId:null,name:'Ana & Pedro',type:'wedding',startAt:new Date('2026-10-17T20:30:00Z'),endAt:new Date('2026-10-18T02:30:00Z'),venueName:'Casa A',venueAddress:'Rua A',guestCount:100,status:'planning',healthScore:100,ownerUserId:null,createdAt:fixed,updatedAt:fixed}
  tasks:EventTask[]=[{id:id(),organizationId:ORG,eventId:EVENT,templateTaskId:null,sourceCommandRequestId:null,title:'Confirmar buffet',description:null,type:'general',status:'pending',priority:'normal',dueAt:new Date('2026-10-01T12:00:00Z'),source:'manual',createdAt:fixed,updatedAt:fixed,completedAt:null}]
  async findTemplateSnapshot():Promise<EventTemplateSnapshot|null>{return null} async createEventWithPlan(){}
  async findEventById(o:string,e:string){return o===ORG&&e===EVENT?this.event:null} async listEvents(){return[this.event]}
  async listEventTasks(){return this.tasks} async listEventMilestones():Promise<EventMilestone[]>{return[]}
  async createTaskWithOutbox(){} async updateTaskWithOutbox(){} async findTaskById(){return null} async findTaskBySourceCommandRequestId(){return null}
}
class VS implements VendorStore {
  vendor:EventVendor={id:id(),organizationId:ORG,eventId:EVENT,vendorId:id(),vendorName:'Buffet X',category:'buffet',contactName:null,phone:null,email:null,confirmationStatus:'confirmed',contractStatus:'signed',paymentStatus:'partial',arrivalAt:new Date('2026-10-17T17:00:00Z'),departureAt:null,teamSize:8,confirmationRequestedAt:fixed,confirmationDeadlineAt:null,confirmedAt:fixed,declinedAt:null,notes:null,createdAt:fixed,updatedAt:fixed}
  constructor(private es:ES){} async createVendor(_v:Vendor){} async findVendorById(){return null} async listVendors(){return[]}
  async findEventById(o:string,e:string){return this.es.findEventById(o,e)} async findEventVendorById(){return null} async findEventVendorByVendorId(){return null}
  async listEventVendors(){return[this.vendor]} async createEventVendorWithOutbox(){} async updateEventVendorWithOutbox(){}
}
class CPS implements ChangeProposalStore {
  values=new Map<string,ChangeProposalWithImpacts>(); events:DomainEvent[]=[]; constructor(private es:ES){}
  async findById(o:string,p:string){const v=this.values.get(p);return v?.proposal.organizationId===o?v:null}
  async findByIdempotencyKey(o:string,k:string){return [...this.values.values()].find(v=>v.proposal.organizationId===o&&v.proposal.idempotencyKey===k)??null}
  async list(i:ListChangeProposalsInput){return [...this.values.values()].filter(v=>v.proposal.organizationId===i.organizationId&&(!i.eventId||v.proposal.eventId===i.eventId)&&(!i.status||v.proposal.status===i.status)&&(!i.requestedBySender||v.proposal.requestedBySender===i.requestedBySender))}
  async createWithOutbox(p:ChangeProposal,impacts:ChangeProposalImpact[],e:DomainEvent){const old=await this.findByIdempotencyKey(p.organizationId,p.idempotencyKey);if(old)return{value:old,created:false};const v={proposal:p,impacts};this.values.set(p.id,v);this.events.push(e);return{value:v,created:true}}
  async applyWithOutbox(p:ChangeProposal,e:Event,events:DomainEvent[]){const old=this.values.get(p.id);if(!old||old.proposal.status!=='proposed')return{value:old??{proposal:p,impacts:[]},applied:false};this.values.set(p.id,{proposal:p,impacts:old.impacts});this.es.event=e;this.events.push(...events);return{value:this.values.get(p.id)!,applied:true}}
  async rejectWithOutbox(p:ChangeProposal,e:DomainEvent){const old=this.values.get(p.id);if(!old||old.proposal.status!=='proposed')return{value:old??{proposal:p,impacts:[]},rejected:false};this.values.set(p.id,{proposal:p,impacts:old.impacts});this.events.push(e);return{value:this.values.get(p.id)!,rejected:true}}
}
const es=new ES(), vs=new VS(es), store=new CPS(es)
const eventEngine=new EventEngine({store:es,now:()=>fixed,newId:id}); const vendorEngine=new VendorEngine({store:vs,now:()=>fixed,newId:id})
const engine=new ChangeProposalEngine({store,eventEngine,vendorEngine,now:()=>fixed,newId:id})

const before=es.event.startAt.toISOString(); const duration=es.event.endAt!.getTime()-es.event.startAt.getTime()
const p1=await engine.create({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',eventId:EVENT,requestedBySender:'planner',idempotencyKey:'time-1',type:'event_time',proposedValue:{time:'17:00'}})
assert(p1.proposal.status==='proposed'&&es.event.startAt.toISOString()===before,'proposal does not mutate event')
assert(p1.impacts.some(i=>i.category==='vendor'),'time proposal calculates vendor impact')
const dup=await engine.create({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',eventId:EVENT,requestedBySender:'planner',idempotencyKey:'time-1',type:'event_time',proposedValue:{time:'17:00'}})
assert(dup.duplicate&&store.values.size===1,'proposal creation is idempotent')
const applied=await engine.approve({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',proposalId:p1.proposal.id,decidedBySender:'planner'})
assert(applied.proposal.status==='applied'&&es.event.startAt.toISOString()!==before,'approval applies event time')
assert(es.event.endAt!.getTime()-es.event.startAt.getTime()===duration,'event duration is preserved')
const appliedDup=await engine.approve({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',proposalId:p1.proposal.id,decidedBySender:'planner'})
assert(appliedDup.duplicate,'repeated approval is idempotent')
const guestBefore=es.event.guestCount
const p2=await engine.create({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',eventId:EVENT,requestedBySender:'planner',idempotencyKey:'guest-1',type:'guest_count',proposedValue:{guestCount:150}})
assert(p2.impacts.some(i=>i.category==='guest'&&i.severity==='critical'),'large guest change is critical')
await engine.reject({organizationId:ORG,proposalId:p2.proposal.id,decidedBySender:'planner'})
assert(es.event.guestCount===guestBefore&&(await engine.get(ORG,p2.proposal.id)).proposal.status==='rejected','rejection never mutates event')
const p3=await engine.create({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',eventId:EVENT,requestedBySender:'planner',idempotencyKey:'date-1',type:'event_date',proposedValue:{date:'2026-10-20'}})
await engine.approve({organizationId:ORG,organizationTimezone:'America/Sao_Paulo',proposalId:p3.proposal.id,decidedBySender:'planner'})
const local=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(es.event.startAt)
assert(local.includes('2026')&&local.includes('10')&&local.includes('20')&&local.includes('17')&&local.includes('00'),'date change preserves local event time')
console.log('ChangeProposalEngine: 8/8 behavioral scenarios passed')
