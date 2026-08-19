import type {
  DomainEvent, Event, EventHealthCurrent, EventHealthEvaluation, EventRisk, HealthEvaluationResult, HealthSnapshot, HealthStore, OutboxMessage,
} from '../../packages/domain/src/index.ts'
import { HealthEngine } from '../../packages/event-engine/src/health-engine.ts'

function assert(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(`Assertion failed: ${msg}`)}
const ORG='11111111-1111-4111-8111-111111111111'
const EVENT='22222222-2222-4222-8222-222222222222'
const fixed=new Date('2026-08-19T12:00:00.000Z')
function event(id=EVENT,name='Ana & Pedro',score=100):Event{return{id,organizationId:ORG,templateId:null,name,type:'wedding',startAt:new Date('2026-10-17T20:30:00Z'),endAt:null,venueName:null,venueAddress:null,guestCount:120,status:'planning',healthScore:score,ownerUserId:null,createdAt:fixed,updatedAt:fixed}}
let riskSeq=0
function risk(type:EventRisk['type'],score:number,severity:EventRisk['severity']='high',status:EventRisk['status']='open'):EventRisk{const id=`33333333-3333-4333-8333-${String(++riskSeq).padStart(12,'0')}`;return{id,organizationId:ORG,eventId:EVENT,riskKey:`${type}:${id}`,type,severity,score,status,sourceType:type.startsWith('task_')?'task':type.startsWith('vendor_')?'event_vendor':type.includes('dependency')?'dependency_impact':type==='critical_inbox_item'?'inbox_item':'change_proposal',sourceId:id,title:`Risk ${type}`,description:'risk',metadata:{},firstDetectedAt:fixed,lastDetectedAt:fixed,acknowledgedAt:status==='acknowledged'?fixed:null,acknowledgedBy:status==='acknowledged'?'planner':null,resolvedAt:null,createdAt:fixed,updatedAt:fixed}}

class Store implements HealthStore{
  snapshots=new Map<string,HealthSnapshot>(); evaluations=new Map<string,EventHealthEvaluation[]>(); triggers=new Set<string>(); outbox:DomainEvent[]=[]
  constructor(){this.snapshots.set(EVENT,{event:event(),activeRisks:[],latestEvaluation:null})}
  async loadSnapshot(o:string,e:string){const s=this.snapshots.get(e);return o===ORG&&s?{...s,event:{...s.event},activeRisks:[...s.activeRisks],latestEvaluation:s.latestEvaluation}:null}
  async reconcileEvaluation(e:EventHealthEvaluation,de:DomainEvent|null):Promise<HealthEvaluationResult>{const key=`${e.organizationId}:${e.eventId}:${e.triggerKey}`;if(this.triggers.has(key)){const latest=(this.evaluations.get(e.eventId)??[])[0]!;return{evaluation:latest,duplicate:true,changed:false}};this.triggers.add(key);const s=this.snapshots.get(e.eventId)!;const changed=s.event.healthScore!==e.score;const normalized={...e,previousScore:s.event.healthScore,delta:e.score-s.event.healthScore};s.event={...s.event,healthScore:e.score,updatedAt:e.evaluatedAt};s.latestEvaluation=normalized;this.evaluations.set(e.eventId,[normalized,...(this.evaluations.get(e.eventId)??[])]);if(de&&changed)this.outbox.push({...de,payload:{...de.payload,previousScore:normalized.previousScore,score:normalized.score,delta:normalized.delta}});return{evaluation:normalized,duplicate:false,changed}}
  async findLatest(o:string,e:string){return o===ORG?(this.evaluations.get(e)??[])[0]??null:null}
  async listHistory(o:string,e:string,limit=30){return o===ORG?(this.evaluations.get(e)??[]).slice(0,limit):[]}
  async listCurrent(o:string,limit=30):Promise<EventHealthCurrent[]>{if(o!==ORG)return[];return[...this.snapshots.values()].map(s=>({event:s.event,score:s.event.healthScore,status:s.latestEvaluation?.status??'excellent',breakdown:s.latestEvaluation?.breakdown??null,evaluatedAt:s.latestEvaluation?.evaluatedAt??null,delta:s.latestEvaluation?.delta??null})).sort((a,b)=>a.score-b.score).slice(0,limit)}
}

const store=new Store();let seq=0;const engine=new HealthEngine({store,now:()=>fixed,newId:()=>`44444444-4444-4444-8444-${String(++seq).padStart(12,'0')}`})
let checks=0
let result=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'empty'})
assert(result.evaluation.score===100&&result.evaluation.status==='excellent','no active risks yields 100 excellent');checks++

store.snapshots.get(EVENT)!.activeRisks=[risk('task_overdue',72,'high')]
result=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'high'})
assert(result.evaluation.score===84&&result.evaluation.breakdown.severityCeiling===84,'one high risk caps score at 84');checks++
assert(result.evaluation.breakdown.categoryPenalties.task===15,'risk score maps to explainable task penalty');checks++

store.snapshots.get(EVENT)!.activeRisks=[risk('vendor_declined',92,'critical')]
result=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'critical-one'})
assert(result.evaluation.score===69&&result.evaluation.status==='attention','one critical risk caps score at 69');checks++

store.snapshots.get(EVENT)!.activeRisks=[risk('vendor_declined',92,'critical'),risk('critical_inbox_item',95,'critical')]
result=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'critical-two'})
assert(result.evaluation.score<=49&&result.evaluation.status==='critical','two critical risks force critical health');checks++

store.snapshots.get(EVENT)!.activeRisks=Array.from({length:5},()=>risk('vendor_unconfirmed',80,'high'))
result=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'vendor-cap'})
assert(result.evaluation.breakdown.categoryPenalties.vendor===35,'vendor category penalty is capped');checks++

store.snapshots.get(EVENT)!.activeRisks=[risk('task_overdue',70,'high','acknowledged')]
result=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'ack'})
assert(result.evaluation.breakdown.acknowledgedRiskCount===1&&result.evaluation.breakdown.totalPenalty>0,'acknowledged risk still affects health');checks++

const dup=await engine.evaluateEvent({organizationId:ORG,eventId:EVENT,triggerType:'manual',triggerKey:'ack'})
assert(dup.duplicate&&!dup.changed,'same trigger is idempotent');checks++

const history=await engine.history(ORG,EVENT,3);assert(history.length===3&&history[0]!.score===result.evaluation.score,'history returns latest evaluations');checks++

const second='55555555-5555-4555-8555-555555555555';store.snapshots.set(second,{event:event(second,'Laura 15 anos',95),activeRisks:[],latestEvaluation:null})
const workspace=await engine.workspace(ORG);assert(workspace[0]!.event.id===EVENT&&workspace[0]!.score<workspace[1]!.score,'workspace ranks least healthy event first');checks++

const irrelevant:OutboxMessage={id:'66666666-6666-4666-8666-666666666661',organizationId:ORG,eventType:'task.created',aggregateType:'task',aggregateId:'77777777-7777-4777-8777-777777777777',payload:{eventId:EVENT},occurredAt:fixed,availableAt:fixed,attempts:0,claimedAt:null,claimedBy:null,dispatchedAt:null,lastError:null}
assert(await engine.evaluateDomainEvent(irrelevant)===null,'non risk-evaluation domain event does not recalculate health');checks++
const riskDone:OutboxMessage={...irrelevant,id:'66666666-6666-4666-8666-666666666662',eventType:'risk.evaluation_completed',aggregateType:'event',aggregateId:EVENT}
const triggered=await engine.evaluateDomainEvent(riskDone);assert(triggered!==null&&triggered.evaluation.triggerType==='risk_evaluation','risk evaluation completion recalculates health');checks++
assert(store.outbox.some(e=>e.eventType==='health.updated'),'score changes emit health.updated domain event');checks++
console.log(`HealthEngine: ${checks}/${checks} behavioral scenarios passed`)
