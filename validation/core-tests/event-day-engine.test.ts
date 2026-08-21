import type {
  DomainEvent, EventDayActivity, EventDaySession, EventDaySource, EventDayStore,
  EventDayTaskRecord, EventDayTaskStatus,
} from '../../packages/domain/src/index.ts'
import { EventDayEngine } from '../../packages/event-engine/src/event-day-engine.ts'

function assert(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(`Assertion failed: ${message}`)}
const EVENT='11111111-1111-4111-8111-111111111111'
const VENDOR='22222222-2222-4222-8222-222222222222'
let current=new Date('2026-08-20T19:45:00.000Z')
let seq=0

class MemoryStore implements EventDayStore{
  source:EventDaySource={
    organizationId:'org-1',timezone:'America/Sao_Paulo',enabled:false,
    event:{id:EVENT,organizationId:'org-1',templateId:null,name:'Casamento ao vivo',type:'wedding',startAt:new Date('2026-08-20T20:30:00.000Z'),endAt:new Date('2026-08-21T02:00:00.000Z'),venueName:'Casa A',venueAddress:null,guestCount:120,status:'ready',healthScore:88,ownerUserId:null,createdAt:current,updatedAt:current},
    session:null,
    vendors:[{id:VENDOR,vendorName:'Foto Prime',category:'photo',confirmationStatus:'confirmed',plannedArrivalAt:new Date('2026-08-20T19:00:00.000Z'),plannedDepartureAt:new Date('2026-08-21T01:00:00.000Z'),actualArrivalAt:null,actualDepartureAt:null}],
    tasks:[],activity:[],
  }
  outbox:DomainEvent[]=[]
  async loadSource(o:string,e:string){return o===this.source.organizationId&&e===this.source.event.id?this.source:null}
  async enable(input:any){if(this.source.enabled)return{duplicate:true};this.source.enabled=true;this.outbox.push(input.domainEvent);return{duplicate:false}}
  async disable(input:any){const duplicate=!this.source.enabled&&this.source.session?.status!=='active';if(duplicate)return{duplicate:true,sessionCompleted:false};const active=this.source.session?.status==='active';this.source.enabled=false;if(active&&this.source.session){this.source.session={...this.source.session,status:'completed',completedAt:input.at,completionReason:'disabled',completedBySender:input.sender,updatedAt:input.at};this.source.event={...this.source.event,status:this.source.session.previousEventStatus,updatedAt:input.at};if(input.activity)this.source.activity.push(input.activity)}this.outbox.push(input.domainEvent);return{duplicate:false,sessionCompleted:active}}
  async startSession(input:{session:EventDaySession;activity:EventDayActivity;domainEvent:DomainEvent}){if(this.source.session?.status==='active')return{session:this.source.session,duplicate:true};this.source.session=input.session;this.source.event={...this.source.event,status:'event_day',updatedAt:input.session.startedAt};this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{session:input.session,duplicate:false}}
  async markVendorArrived(input:any){const v=this.source.vendors.find(x=>x.id===input.eventVendorId)!;if(v.actualArrivalAt)return{duplicate:true};v.actualArrivalAt=input.at;this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{duplicate:false}}
  async markVendorDeparted(input:any){const v=this.source.vendors.find(x=>x.id===input.eventVendorId)!;if(v.actualDepartureAt)return{duplicate:true};if(!v.actualArrivalAt)throw new Error('arrival required');v.actualDepartureAt=input.at;this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{duplicate:false}}
  async completeSession(input:any){if(!this.source.session)throw new Error('missing');if(this.source.session.status==='completed')return{duplicate:true};const previous=this.source.session.previousEventStatus;this.source.session={...this.source.session,status:'completed',completedAt:input.at,completionReason:'manual',completedBySender:input.sender,updatedAt:input.at};this.source.event={...this.source.event,status:previous,updatedAt:input.at};this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{duplicate:false}}
  async createTask(input:{task:EventDayTaskRecord;domainEvent:DomainEvent}){this.source.tasks.push({...input.task});this.outbox.push(input.domainEvent)}
  async updateTask(input:{organizationId:string;eventId:string;taskId:string;status:EventDayTaskStatus;at:Date;sender:string;domainEvent:DomainEvent}){const task=this.source.tasks.find(t=>t.id===input.taskId);if(!task)throw new Error('task missing');if(task.status===input.status)return{duplicate:true,task:{organizationId:this.source.organizationId,eventId:this.source.event.id,...task}};task.status=input.status;task.updatedAt=input.at;task.completedAt=input.status==='completed'?input.at:null;this.outbox.push(input.domainEvent);return{duplicate:false,task:{organizationId:this.source.organizationId,eventId:this.source.event.id,...task}}}
}

const store=new MemoryStore()
const engine=new EventDayEngine({store,now:()=>current,newId:()=>`33333333-3333-4333-8333-${String(++seq).padStart(12,'0')}`})

{
  const snapshot=await engine.get('org-1',EVENT)
  assert(snapshot.operationalStatus==='disabled'&&!snapshot.enabled,'Event Day is opt-in and disabled by default')
  assert(snapshot.vendors[0]?.liveStatus==='late','planned supplier state may be visible without activating live management')
  let blocked=false
  try{await engine.start({organizationId:'org-1',eventId:EVENT,sender:'planner'})}catch(error){blocked=typeof error==='object'&&error!==null&&'code'in error&&(error as any).code==='EVENT_DAY_CONFLICT'}
  assert(blocked,'disabled Event Day cannot start')
}
{
  const enabled=await engine.enable({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(enabled.snapshot.enabled&&enabled.snapshot.operationalStatus==='not_started','Event Day can be enabled independently from starting a session')
}
{
  const result=await engine.start({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(!result.duplicate&&result.snapshot.session?.status==='active','Event Day starts once after opt-in')
  assert(result.snapshot.session?.previousEventStatus==='ready','session remembers lifecycle status to restore later')
  assert(result.snapshot.operationalStatus==='critical','30+ minute supplier delay makes live operation critical')
  assert(store.source.event.status==='event_day','starting Event Day updates this event lifecycle only')
}
let operationTaskId=''
{
  const created=await engine.createTask({organizationId:'org-1',eventId:EVENT,sender:'planner',title:'Conferir gerador',kind:'operation',priority:'high'})
  operationTaskId=created.task.id
  assert(created.task.kind==='operation'&&created.snapshot.counts.openTasks===1,'operational Event Day task is persisted in live snapshot')
  assert(store.outbox.at(-1)?.eventType==='event_day.task_created','task creation emits a domain event')
}
let incidentId=''
{
  const created=await engine.createTask({organizationId:'org-1',eventId:EVENT,sender:'planner',title:'Gerador parou',kind:'incident',priority:'critical'})
  incidentId=created.task.id
  assert(created.snapshot.counts.openIncidents===1&&created.snapshot.counts.criticalOpenIncidents===1,'critical complication is represented as an incident task')
  assert(created.snapshot.operationalStatus==='critical','critical incident makes live status critical')
}
{
  const resolved=await engine.resolveIncident({organizationId:'org-1',eventId:EVENT,taskId:incidentId,sender:'planner'})
  assert(resolved.task.status==='completed'&&resolved.snapshot.counts.openIncidents===0&&resolved.snapshot.counts.resolvedIncidents===1,'incident can be explicitly resolved')
}
{
  const arrival=await engine.markVendorArrived({organizationId:'org-1',eventId:EVENT,eventVendorId:VENDOR,sender:'planner'})
  assert(!arrival.duplicate&&arrival.snapshot.vendors[0]?.liveStatus==='arrived','actual arrival clears supplier lateness')
  assert(arrival.snapshot.vendors[0]?.plannedArrivalAt==='2026-08-20T19:00:00.000Z','planned arrival remains immutable operational plan')
}
{
  const started=await engine.startTask({organizationId:'org-1',eventId:EVENT,taskId:operationTaskId,sender:'planner'})
  assert(started.task.status==='in_progress','operational task can be started')
  const completed=await engine.completeTask({organizationId:'org-1',eventId:EVENT,taskId:operationTaskId,sender:'planner'})
  assert(completed.task.status==='completed'&&completed.snapshot.counts.openTasks===0,'operational task can be completed')
}
{
  current=new Date('2026-08-21T00:10:00.000Z')
  const departed=await engine.markVendorDeparted({organizationId:'org-1',eventId:EVENT,eventVendorId:VENDOR,sender:'planner'})
  assert(departed.snapshot.vendors[0]?.liveStatus==='departed','vendor departure remains part of live execution')
}
{
  const completed=await engine.complete({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(completed.snapshot.operationalStatus==='completed','manual completion closes only the Event Day session')
  assert(store.source.event.status==='ready','manual Event Day completion restores previous event lifecycle instead of completing the business event')
  assert(store.source.enabled,'manual session completion keeps Event Day capability enabled')
}
{
  current=new Date('2026-08-20T20:15:00.000Z')
  const restarted=await engine.start({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(!restarted.duplicate&&restarted.snapshot.session?.status==='active','historical completed session does not prevent a new live session')
  const disabled=await engine.disable({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(!disabled.snapshot.enabled&&disabled.snapshot.operationalStatus==='disabled','disabling Event Day closes active session and turns capability off')
  assert(store.source.event.status==='ready','disabling restores prior lifecycle state')
  assert(store.source.session?.completionReason==='disabled','session records why it ended')
}
{
  const other=new MemoryStore();other.source.event={...other.source.event,id:'44444444-4444-4444-8444-444444444444',name:'Outro evento'}
  assert(!other.source.enabled&&other.source.event.status==='ready','another event remains independent and disabled')
  await engine.enable({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(!other.source.enabled&&other.source.event.status==='ready','changing Event Day on one event never mutates another event')
}

console.log('EventDayEngine: 12/12 behavioral scenarios passed')
