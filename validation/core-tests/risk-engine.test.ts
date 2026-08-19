import type {
  ActiveEventRef, DependencyImpact, DomainEvent, Event, EventRisk, EventTask, EventVendor, InboxItem, ListRisksInput,
  RiskCandidate, RiskEvaluation, RiskReconciliationResult, RiskSnapshot, RiskStore,
} from '../../packages/domain/src/index.ts'
import { RiskEngine } from '../../packages/event-engine/src/risk-engine.ts'

function assert(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(`Assertion failed: ${msg}`)}
const ORG='11111111-1111-4111-8111-111111111111'
const EVENT='22222222-2222-4222-8222-222222222222'
const fixed=new Date('2026-08-19T12:00:00.000Z')
const event:Event={id:EVENT,organizationId:ORG,templateId:null,name:'Ana & Pedro',type:'wedding',startAt:new Date('2026-08-22T17:00:00.000Z'),endAt:null,venueName:'Casa A',venueAddress:null,guestCount:120,status:'planning',healthScore:100,ownerUserId:null,createdAt:fixed,updatedAt:fixed}
const taskOverdue:EventTask={id:'33333333-3333-4333-8333-333333333331',organizationId:ORG,eventId:EVENT,templateTaskId:null,sourceCommandRequestId:null,title:'Confirmar buffet',description:null,type:'confirmation',status:'pending',priority:'critical',dueAt:new Date('2026-08-18T12:00:00Z'),source:'manual',createdAt:fixed,updatedAt:fixed,completedAt:null}
const taskSoon:EventTask={...taskOverdue,id:'33333333-3333-4333-8333-333333333332',title:'Enviar briefing',priority:'high',dueAt:new Date('2026-08-20T08:00:00Z')}
function vendor(id:string,name:string,status:EventVendor['confirmationStatus']):EventVendor{return{id,organizationId:ORG,eventId:EVENT,vendorId:id.replace(/.$/,'9'),vendorName:name,category:'buffet',contactName:null,phone:null,email:null,confirmationStatus:status,contractStatus:'signed',paymentStatus:'partial',arrivalAt:null,departureAt:null,teamSize:null,confirmationRequestedAt:new Date('2026-08-10T12:00:00Z'),confirmationDeadlineAt:new Date('2026-08-18T12:00:00Z'),confirmedAt:null,declinedAt:status==='declined'?fixed:null,notes:null,createdAt:fixed,updatedAt:fixed}}
function dep(id:string,proposalId:string,type:DependencyImpact['dependencyType'],severity:DependencyImpact['severity']):DependencyImpact{return{id,organizationId:ORG,eventId:EVENT,proposalId,sourceChangeEventId:'77777777-7777-4777-8777-777777777777',ruleKey:`rule.${id}`,dependencyType:type,entityType:type==='manual_schedule_review'?'event':'event_vendor',entityId:type==='manual_schedule_review'?EVENT:'44444444-4444-4444-8444-444444444441',action:type==='vendor_schedule'?'suggest_update':'review',severity,status:'open',title:type==='vendor_schedule'?'Ajustar horário do buffet':'Revisar tarefas manuais',description:'Dependência aberta',currentValue:{},suggestedValue:type==='vendor_schedule'?{arrivalAt:'2026-08-22T14:00:00Z'}:null,metadata:{},createdAt:fixed,updatedAt:fixed,resolvedAt:null}}
const criticalInbox:InboxItem={id:'88888888-8888-4888-8888-888888888888',organizationId:ORG,eventId:EVENT,sourceEventId:'99999999-9999-4999-8999-999999999999',type:'manual_alert',severity:'critical',sourceType:'inbound_message',sourceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'Cliente exige decisão imediata',description:'Revisar solicitação crítica.',status:'open',assignedTo:null,metadata:{},createdAt:fixed,updatedAt:fixed,resolvedAt:null}

class Store implements RiskStore{
  snapshot:RiskSnapshot={event:{...event},tasks:[{...taskOverdue},{...taskSoon}],vendors:[vendor('44444444-4444-4444-8444-444444444441','Buffet X','requested'),vendor('44444444-4444-4444-8444-444444444442','DJ Y','declined')],dependencies:[dep('55555555-5555-4555-8555-555555555551','66666666-6666-4666-8666-666666666666','vendor_schedule','warning'),dep('55555555-5555-4555-8555-555555555552','66666666-6666-4666-8666-666666666666','manual_schedule_review','critical')],inbox:[criticalInbox],appliedChanges:[{id:'66666666-6666-4666-8666-666666666666',type:'event_time',appliedAt:new Date('2026-08-18T18:00:00Z'),currentValue:{time:'17:30'},proposedValue:{time:'17:00'}}]}
  risks=new Map<string,EventRisk>();evaluations=new Set<string>();evaluationCalls=0
  async loadSnapshot(o:string,e:string){return o===ORG&&e===EVENT?this.snapshot:null}
  async listActiveEventRefs():Promise<ActiveEventRef[]>{return this.snapshot.event.status==='completed'?[]:[{organizationId:ORG,eventId:EVENT}]}
  async findById(o:string,id:string){const v=[...this.risks.values()].find(r=>r.id===id);return v?.organizationId===o?v:null}
  async list(input:ListRisksInput){return [...this.risks.values()].filter(r=>r.organizationId===input.organizationId&&(!input.eventId||r.eventId===input.eventId)&&(!input.status||r.status===input.status)&&(!input.severity||r.severity===input.severity)&&(!input.type||r.type===input.type)&&(input.minScore===undefined||r.score>=input.minScore)).sort((a,b)=>b.score-a.score).slice(0,input.limit??50)}
  async listActive(o:string,limit=200){return [...this.risks.values()].filter(r=>r.organizationId===o&&r.status!=='resolved').sort((a,b)=>b.score-a.score).slice(0,limit)}
  async reconcileEvaluation(e:RiskEvaluation,candidates:RiskCandidate[]):Promise<RiskReconciliationResult>{
    this.evaluationCalls++;const key=`${e.organizationId}:${e.eventId}:${e.triggerKey}`;if(this.evaluations.has(key))return{risks:await this.listActive(e.organizationId),detected:0,updated:0,resolved:0,duplicate:true};this.evaluations.add(key)
    const desired=new Set(candidates.map(c=>c.riskKey));let detected=0,updated=0,resolved=0
    for(const c of candidates){const old=this.risks.get(c.riskKey);if(!old||old.status==='resolved'){this.risks.set(c.riskKey,{...c,status:'open',firstDetectedAt:old?.firstDetectedAt??e.evaluatedAt,lastDetectedAt:e.evaluatedAt,acknowledgedAt:null,acknowledgedBy:null,resolvedAt:null,createdAt:old?.createdAt??e.evaluatedAt,updatedAt:e.evaluatedAt});detected++}else{if(old.score!==c.score||old.severity!==c.severity)updated++;this.risks.set(c.riskKey,{...old,...c,status:old.status,lastDetectedAt:e.evaluatedAt,updatedAt:e.evaluatedAt,resolvedAt:null})}}
    for(const [k,r] of [...this.risks])if(r.eventId===e.eventId&&r.status!=='resolved'&&!desired.has(k)){this.risks.set(k,{...r,status:'resolved',resolvedAt:e.evaluatedAt,updatedAt:e.evaluatedAt});resolved++}
    return{risks:[...this.risks.values()].filter(r=>r.eventId===e.eventId&&r.status!=='resolved').sort((a,b)=>b.score-a.score),detected,updated,resolved,duplicate:false}
  }
  async acknowledge(risk:EventRisk,sender:string,event:DomainEvent){const current=this.risks.get(risk.riskKey)!;if(current.status==='acknowledged')return{risk:current,acknowledged:false};const changed={...current,status:'acknowledged' as const,acknowledgedAt:event.occurredAt,acknowledgedBy:sender,updatedAt:event.occurredAt};this.risks.set(risk.riskKey,changed);return{risk:changed,acknowledged:true}}
}

const store=new Store();let seq=0;const engine=new RiskEngine({store,now:()=>fixed,newId:()=>`bbbbbbbb-bbbb-4bbb-8bbb-${String(++seq).padStart(12,'0')}`})
let checks=0
const first=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:first'})
assert(first.detected>=8,'initial evaluation detects operational risks');checks++
for(const type of ['task_overdue','task_due_soon','vendor_unconfirmed','vendor_declined','vendor_schedule_review','dependency_unresolved','critical_inbox_item','recent_sensitive_change','change_dependency_pending'] as const){assert(first.risks.some(r=>r.type===type),`${type} generated`);checks++}
assert(first.risks.find(r=>r.type==='vendor_declined')?.severity==='critical','declined vendor near event is critical');checks++
assert(first.risks.find(r=>r.type==='task_overdue')!.score>first.risks.find(r=>r.type==='task_due_soon')!.score,'overdue critical task ranks above due-soon task');checks++
const duplicate=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:first'});assert(duplicate.duplicate&&duplicate.detected===0,'same trigger is idempotent');checks++
const summary=await engine.workspaceSummary(ORG);assert(summary[0]?.eventId===EVENT&&summary[0].maxScore===Math.max(...first.risks.map(r=>r.score)),'workspace summary ranks by max risk score');checks++
const toAck=first.risks.find(r=>r.type==='vendor_declined')!;const ack=await engine.acknowledge({organizationId:ORG,riskId:toAck.id,sender:'planner'});assert(ack.risk.status==='acknowledged'&&!ack.duplicate,'acknowledgement records awareness without resolution');checks++
const ackAgain=await engine.acknowledge({organizationId:ORG,riskId:toAck.id,sender:'planner'});assert(ackAgain.duplicate,'risk acknowledgement is idempotent');checks++

store.snapshot.tasks=store.snapshot.tasks.map(t=>({...t,status:'completed',completedAt:fixed}))
store.snapshot.vendors=store.snapshot.vendors.map(v=>({...v,confirmationStatus:'confirmed',confirmedAt:fixed,declinedAt:null,confirmationDeadlineAt:null}))
store.snapshot.dependencies=[];store.snapshot.inbox=[];store.snapshot.appliedChanges=[]
const cleared=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:cleared'});assert(cleared.resolved>=8&&cleared.risks.length===0,'risks auto-resolve when causes disappear');checks++
store.snapshot.event={...store.snapshot.event,status:'completed'}
const completed=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'manual:completed'});assert(completed.risks.length===0,'completed event produces no active risk');checks++
store.snapshot.event={...store.snapshot.event,status:'planning'}
await engine.evaluateScheduled(300000,fixed);const before=store.evaluations.size;await engine.evaluateScheduled(300000,fixed);assert(store.evaluations.size===before,'scheduled evaluation uses stable time bucket idempotency');checks++
console.log(`RiskEngine: ${checks}/${checks} behavioral scenarios passed`)
