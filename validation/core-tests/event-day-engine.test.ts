import type { DomainEvent, EventDayActivity, EventDaySession, EventDaySource, EventDayStore } from '../../packages/domain/src/index.ts'
import { EventDayEngine } from '../../packages/event-engine/src/event-day-engine.ts'

function assert(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(`Assertion failed: ${message}`)}
const EVENT='11111111-1111-4111-8111-111111111111'
const VENDOR='22222222-2222-4222-8222-222222222222'
let current=new Date('2026-08-20T19:45:00.000Z')
let seq=0

class MemoryStore implements EventDayStore{
  source:EventDaySource={
    organizationId:'org-1',timezone:'America/Sao_Paulo',
    event:{id:EVENT,organizationId:'org-1',templateId:null,name:'Casamento ao vivo',type:'wedding',startAt:new Date('2026-08-20T20:30:00.000Z'),endAt:new Date('2026-08-21T02:00:00.000Z'),venueName:'Casa A',venueAddress:null,guestCount:120,status:'ready',healthScore:88,ownerUserId:null,createdAt:current,updatedAt:current},
    session:null,
    vendors:[{id:VENDOR,vendorName:'Foto Prime',category:'photo',confirmationStatus:'confirmed',plannedArrivalAt:new Date('2026-08-20T19:00:00.000Z'),plannedDepartureAt:new Date('2026-08-21T01:00:00.000Z'),actualArrivalAt:null,actualDepartureAt:null}],
    tasks:[],activity:[],
  }
  outbox:DomainEvent[]=[]
  async loadSource(o:string,e:string){return o===this.source.organizationId&&e===this.source.event.id?this.source:null}
  async startSession(input:{session:EventDaySession;activity:EventDayActivity;domainEvent:DomainEvent}){if(this.source.session)return{session:this.source.session,duplicate:true};this.source.session=input.session;this.source.event={...this.source.event,status:'event_day',updatedAt:input.session.startedAt};this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{session:input.session,duplicate:false}}
  async markVendorArrived(input:any){const v=this.source.vendors.find(x=>x.id===input.eventVendorId)!;if(v.actualArrivalAt)return{duplicate:true};v.actualArrivalAt=input.at;this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{duplicate:false}}
  async markVendorDeparted(input:any){const v=this.source.vendors.find(x=>x.id===input.eventVendorId)!;if(v.actualDepartureAt)return{duplicate:true};if(!v.actualArrivalAt)throw new Error('arrival required');v.actualDepartureAt=input.at;this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{duplicate:false}}
  async completeSession(input:any){if(!this.source.session)throw new Error('missing');if(this.source.session.status==='completed')return{duplicate:true};this.source.session={...this.source.session,status:'completed',completedAt:input.at,completedBySender:input.sender,updatedAt:input.at};this.source.event={...this.source.event,status:'completed',updatedAt:input.at};this.source.activity.push(input.activity);this.outbox.push(input.domainEvent);return{duplicate:false}}
}

const store=new MemoryStore()
const engine=new EventDayEngine({store,now:()=>current,newId:()=>`33333333-3333-4333-8333-${String(++seq).padStart(12,'0')}`})

{
  const snapshot=await engine.get('org-1',EVENT)
  assert(snapshot.operationalStatus==='not_started','event day snapshot exists before session start')
  assert(snapshot.vendors[0]?.liveStatus==='late'&&snapshot.vendors[0]?.minutesLate===45,'planned supplier delay is deterministic')
}
{
  const result=await engine.start({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(!result.duplicate&&result.snapshot.session?.status==='active','Event Day starts once')
  assert(result.snapshot.operationalStatus==='critical','30+ minute supplier delay makes live operation critical')
  assert(store.source.event.status==='event_day','starting Event Day updates event lifecycle status')
  assert(store.outbox.at(-1)?.eventType==='event_day.started','start is emitted through transactional outbox contract')
}
{
  const duplicate=await engine.start({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(duplicate.duplicate,'Event Day start is idempotent per event')
}
{
  const arrival=await engine.markVendorArrived({organizationId:'org-1',eventId:EVENT,eventVendorId:VENDOR,sender:'planner'})
  assert(!arrival.duplicate&&arrival.snapshot.vendors[0]?.liveStatus==='arrived','actual arrival is recorded separately from plan')
  assert(arrival.snapshot.operationalStatus==='on_track','arrival clears supplier lateness immediately')
  assert(arrival.snapshot.vendors[0]?.plannedArrivalAt==='2026-08-20T19:00:00.000Z','planned arrival is preserved')
  assert(store.outbox.at(-1)?.eventType==='event_day.vendor_arrived','arrival emits domain event')
}
{
  const duplicate=await engine.markVendorArrived({organizationId:'org-1',eventId:EVENT,eventVendorId:VENDOR,sender:'planner'})
  assert(duplicate.duplicate,'repeated arrival is idempotent')
}
{
  current=new Date('2026-08-21T00:10:00.000Z')
  const departed=await engine.markVendorDeparted({organizationId:'org-1',eventId:EVENT,eventVendorId:VENDOR,sender:'planner'})
  assert(!departed.duplicate&&departed.snapshot.vendors[0]?.liveStatus==='departed','vendor departure is tracked')
}
{
  const completed=await engine.complete({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(!completed.duplicate&&completed.snapshot.operationalStatus==='completed','Event Day completion closes live mode')
  assert(store.source.event.status==='completed','event lifecycle becomes completed')
  const again=await engine.complete({organizationId:'org-1',eventId:EVENT,sender:'planner'})
  assert(again.duplicate,'Event Day completion is idempotent')
}
{
  const other=new MemoryStore();other.source.event={...other.source.event,id:'44444444-4444-4444-8444-444444444444',startAt:new Date('2026-08-22T20:00:00.000Z')}
  const otherEngine=new EventDayEngine({store:other,now:()=>new Date('2026-08-20T20:00:00.000Z')})
  let blocked=false
  try{await otherEngine.start({organizationId:'org-1',eventId:other.source.event.id,sender:'planner'})}catch(error){blocked=typeof error==='object'&&error!==null&&'code'in error&&(error as any).code==='EVENT_DAY_VALIDATION_ERROR'}
  assert(blocked,'Event Day cannot start outside the event local date')
}

console.log('EventDayEngine: 8/8 behavioral scenarios passed')
