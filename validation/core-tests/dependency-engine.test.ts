import type {
  DependencyEntityUpdate,
  DependencyEvaluation,
  DependencyImpact,
  DependencyStore,
  DomainEvent,
  Event,
  EventMilestone,
  EventStore,
  EventTask,
  EventTemplateSnapshot,
  EventVendor,
  ListDependencyImpactsInput,
  OutboxMessage,
  Vendor,
  VendorStore,
} from '../../packages/domain/src/index.ts'
import { DependencyConflictError } from '../../packages/domain/src/index.ts'
import { DependencyEngine } from '../../packages/event-engine/src/dependency-engine.ts'
import { EventEngine } from '../../packages/event-engine/src/event-engine.ts'
import { VendorEngine } from '../../packages/event-engine/src/vendor-engine.ts'

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Assertion failed: ${message}`) }
const ORG='11111111-1111-4111-8111-111111111110'
const EVENT='11111111-1111-4111-8111-111111111111'
const PROPOSAL='22222222-2222-4222-8222-222222222222'
const TASK='33333333-3333-4333-8333-333333333331'
const MANUAL='33333333-3333-4333-8333-333333333332'
const MILESTONE='44444444-4444-4444-8444-444444444441'
const EVENDOR='55555555-5555-4555-8555-555555555551'
const VENDOR='55555555-5555-4555-8555-555555555552'
const fixed=new Date('2026-08-18T12:00:00Z')
let seq=0
const newId=()=>`99999999-9999-4999-8999-${String(++seq).padStart(12,'0')}`

class ES implements EventStore {
  event:Event={id:EVENT,organizationId:ORG,templateId:null,name:'Ana & Pedro',type:'wedding',startAt:new Date('2026-10-24T20:30:00Z'),endAt:null,venueName:'Casa B',venueAddress:'Rua B',guestCount:125,status:'planning',healthScore:100,ownerUserId:null,createdAt:fixed,updatedAt:fixed}
  tasks:EventTask[]=[
    {id:TASK,organizationId:ORG,eventId:EVENT,templateTaskId:'77777777-7777-4777-8777-777777777771',sourceCommandRequestId:null,title:'Confirmar fornecedores',description:null,type:'confirmation',status:'pending',priority:'critical',dueAt:new Date('2026-10-10T13:00:00Z'),source:'template',createdAt:fixed,updatedAt:fixed,completedAt:null},
    {id:MANUAL,organizationId:ORG,eventId:EVENT,templateTaskId:null,sourceCommandRequestId:null,title:'Ligar para a noiva',description:null,type:'general',status:'pending',priority:'normal',dueAt:new Date('2026-10-12T15:00:00Z'),source:'manual',createdAt:fixed,updatedAt:fixed,completedAt:null},
  ]
  milestones:EventMilestone[]=[{id:MILESTONE,organizationId:ORG,eventId:EVENT,templateMilestoneId:'88888888-8888-4888-8888-888888888881',name:'Briefing final',description:null,dueAt:new Date('2026-10-16T22:00:00Z'),status:'pending',source:'template',createdAt:fixed,updatedAt:fixed,completedAt:null}]
  async findTemplateSnapshot():Promise<EventTemplateSnapshot|null>{return null} async createEventWithPlan(){}
  async findEventById(o:string,e:string){return o===ORG&&e===EVENT?this.event:null} async listEvents(){return[this.event]}
  async listEventTasks(){return this.tasks} async listEventMilestones(){return this.milestones}
  async createTaskWithOutbox(){} async updateTaskWithOutbox(){} async findTaskById(){return null} async findTaskBySourceCommandRequestId(){return null}
}
class VS implements VendorStore {
  vendor:EventVendor={id:EVENDOR,organizationId:ORG,eventId:EVENT,vendorId:VENDOR,vendorName:'Buffet X',category:'buffet',contactName:null,phone:null,email:null,confirmationStatus:'confirmed',contractStatus:'signed',paymentStatus:'partial',arrivalAt:new Date('2026-10-17T17:30:00Z'),departureAt:new Date('2026-10-18T02:00:00Z'),teamSize:8,confirmationRequestedAt:fixed,confirmationDeadlineAt:null,confirmedAt:fixed,declinedAt:null,notes:null,createdAt:fixed,updatedAt:fixed}
  constructor(private es:ES){} async createVendor(_v:Vendor){} async findVendorById(){return null} async listVendors(){return[]}
  async findEventById(o:string,e:string){return this.es.findEventById(o,e)} async findEventVendorById(){return null} async findEventVendorByVendorId(){return null}
  async listEventVendors(){return[this.vendor]} async createEventVendorWithOutbox(){} async updateEventVendorWithOutbox(){}
}
class DS implements DependencyStore {
  values=new Map<string,DependencyImpact>(); sourceSeen=new Set<string>(); events:DomainEvent[]=[]; updates:DependencyEntityUpdate[]=[]
  async hasEvaluation(_o:string,s:string){return this.sourceSeen.has(s)}
  async findById(o:string,id:string){const v=this.values.get(id);return v?.organizationId===o?v:null}
  async list(i:ListDependencyImpactsInput){return [...this.values.values()].filter(v=>v.organizationId===i.organizationId&&(!i.eventId||v.eventId===i.eventId)&&(!i.proposalId||v.proposalId===i.proposalId)&&(!i.status||v.status===i.status)&&(!i.action||v.action===i.action)&&(!i.dependencyType||v.dependencyType===i.dependencyType)).slice(0,i.limit??50)}
  async findBySourceChangeEvent(o:string,s:string){return [...this.values.values()].filter(v=>v.organizationId===o&&v.sourceChangeEventId===s)}
  async createEvaluation(evaluation:DependencyEvaluation,impacts:DependencyImpact[],events:DomainEvent[]){const source=evaluation.sourceChangeEventId;if(this.sourceSeen.has(source))return{impacts:await this.findBySourceChangeEvent(ORG,source),created:false};this.sourceSeen.add(source);for(const i of impacts)this.values.set(i.id,i);this.events.push(...events);return{impacts,created:true}}
  async applySuggestion(impact:DependencyImpact,update:DependencyEntityUpdate,event:DomainEvent){const current=this.values.get(impact.id);if(!current)throw new Error('missing');if(current.status==='applied')return{impact:current,applied:false};if(current.status!=='open')throw new DependencyConflictError('not open');this.updates.push(update);const changed={...current,status:'applied' as const,updatedAt:event.occurredAt,resolvedAt:event.occurredAt};this.values.set(changed.id,changed);this.events.push(event);return{impact:changed,applied:true}}
  async resolveReview(impact:DependencyImpact,event:DomainEvent){const current=this.values.get(impact.id)!;if(current.status==='resolved')return{impact:current,resolved:false};const changed={...current,status:'resolved' as const,updatedAt:event.occurredAt,resolvedAt:event.occurredAt};this.values.set(changed.id,changed);this.events.push(event);return{impact:changed,resolved:true}}
  async dismiss(impact:DependencyImpact,event:DomainEvent){const current=this.values.get(impact.id)!;if(current.status==='dismissed')return{impact:current,dismissed:false};const changed={...current,status:'dismissed' as const,updatedAt:event.occurredAt,resolvedAt:event.occurredAt};this.values.set(changed.id,changed);this.events.push(event);return{impact:changed,dismissed:true}}
}
function message(id:string,type:'event_date'|'event_time'|'guest_count'|'venue',currentValue:Record<string,unknown>,proposedValue:Record<string,unknown>):OutboxMessage{return{id,organizationId:ORG,eventType:'change.applied',aggregateType:'change_proposal',aggregateId:PROPOSAL,occurredAt:fixed,payload:{proposalId:PROPOSAL,eventId:EVENT,changeType:type,currentValue,proposedValue},attempts:0,availableAt:fixed,claimedAt:null,claimedBy:null,dispatchedAt:null,lastError:null}}

const es=new ES(),vs=new VS(es),ds=new DS();const eventEngine=new EventEngine({store:es}),vendorEngine=new VendorEngine({store:vs});const engine=new DependencyEngine({store:ds,eventEngine,vendorEngine,now:()=>fixed,newId})
let checks=0
{
  const r=await engine.evaluateAppliedChange(message('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','event_date',{date:'2026-10-17'},{date:'2026-10-24'}),'America/Sao_Paulo')
  assert(r.created,'date evaluation created');checks++
  assert(r.impacts.some(i=>i.dependencyType==='task_due_date'&&i.action==='suggest_update'),'template task suggestion generated');checks++
  assert(r.impacts.some(i=>i.dependencyType==='milestone_due_date'),'template milestone suggestion generated');checks++
  assert(r.impacts.some(i=>i.dependencyType==='manual_schedule_review'&&i.action==='review'),'manual task review generated');checks++
  assert(r.impacts.some(i=>i.dependencyType==='vendor_schedule')&&r.impacts.some(i=>i.dependencyType==='vendor_reconfirmation'),'vendor schedule and reconfirmation impacts generated');checks++
  const task=r.impacts.find(i=>i.entityId===TASK)!;assert(task.suggestedValue?.dueAt==='2026-10-17T13:00:00.000Z','calendar-day shift preserves local task time');checks++
  const dup=await engine.evaluateAppliedChange(message('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','event_date',{date:'2026-10-17'},{date:'2026-10-24'}),'America/Sao_Paulo');assert(!dup.created&&dup.impacts.length===r.impacts.length,'evaluation is source-event idempotent');checks++
  const applied=await engine.applySuggestion({organizationId:ORG,impactId:task.id,decidedBySender:'planner'});assert(!applied.duplicate&&applied.impact.status==='applied'&&ds.updates[0]?.entityType==='task','single deterministic suggestion applies through store');checks++
  const review=r.impacts.find(i=>i.dependencyType==='vendor_reconfirmation')!;const resolved=await engine.resolveReview({organizationId:ORG,impactId:review.id,decidedBySender:'planner'});assert(resolved.impact.status==='resolved','manual review can be resolved explicitly');checks++
  const bulk=await engine.applySuggestionsForProposal({organizationId:ORG,proposalId:PROPOSAL,decidedBySender:'planner'});assert(bulk.applied>=2&&bulk.failed.length===0,'bulk apply executes remaining safe suggestions');checks++
}
{
  const r=await engine.evaluateAppliedChange(message('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','event_time',{time:'17:30'},{time:'17:00'}),'America/Sao_Paulo')
  const schedule=r.impacts.find(i=>i.dependencyType==='vendor_schedule')!;assert(schedule.suggestedValue?.arrivalAt==='2026-10-17T17:00:00.000Z','event time delta shifts vendor schedule');checks++
}
{
  const r=await engine.evaluateAppliedChange(message('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','guest_count',{guestCount:100},{guestCount:150}),'America/Sao_Paulo')
  assert(r.impacts.some(i=>i.dependencyType==='guest_capacity_review'&&i.severity==='critical'&&i.action==='review'),'large guest delta creates critical capacity review');checks++
}
{
  const r=await engine.evaluateAppliedChange(message('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','venue',{venueName:'Casa A'},{venueName:'Casa B'}),'America/Sao_Paulo')
  assert(r.impacts.some(i=>i.dependencyType==='venue_logistics_review'&&i.entityType==='event_vendor'),'venue change creates vendor logistics review');checks++
}

{
  const originalStatus=vs.vendor.confirmationStatus
  vs.vendor.confirmationStatus='pending'
  const emptyMessage=message('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','event_time',{time:'17:00'},{time:'17:15'})
  const first=await engine.evaluateAppliedChange(emptyMessage,'America/Sao_Paulo')
  const second=await engine.evaluateAppliedChange(emptyMessage,'America/Sao_Paulo')
  assert(first.created&&first.impacts.length===0&&!second.created&&second.impacts.length===0,'zero-impact evaluations are still idempotently recorded');checks++
  vs.vendor.confirmationStatus=originalStatus
}
console.log(`DependencyEngine: ${checks}/${checks} behavioral scenarios passed`)
