import {
  EventDayConflictError,
  EventDayNotFoundError,
  EventDayValidationError,
  type DomainEvent,
  type EventDayActivity,
  type EventDayActivityType,
  type EventDayMutationResult,
  type EventDayOperationalStatus,
  type EventDaySession,
  type EventDaySnapshot,
  type EventDaySource,
  type EventDaySourceVendor,
  type EventDayStore,
  type EventDayTimelineItem,
  type EventDayVendorSnapshot,
  type EventDayVendorStatus,
} from '@ecc/domain'

export interface EventDayEngineDependencies {
  store: EventDayStore
  now?: () => Date
  newId?: () => string
  arrivalGraceMinutes?: number
  criticalLateMinutes?: number
}

export class EventDayEngine {
  private readonly now:()=>Date
  private readonly newId:()=>string
  private readonly arrivalGraceMinutes:number
  private readonly criticalLateMinutes:number

  constructor(private readonly deps:EventDayEngineDependencies){
    this.now=deps.now??(()=>new Date())
    this.newId=deps.newId??(()=>crypto.randomUUID())
    this.arrivalGraceMinutes=clamp(deps.arrivalGraceMinutes??15,0,120)
    this.criticalLateMinutes=clamp(deps.criticalLateMinutes??30,this.arrivalGraceMinutes,240)
  }

  async get(organizationId:string,eventId:string):Promise<EventDaySnapshot>{
    const source=await this.requireSource(organizationId,eventId)
    return buildSnapshot(source,this.now(),this.arrivalGraceMinutes,this.criticalLateMinutes)
  }

  async start(input:{organizationId:string;eventId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender)
    const now=this.now()
    const source=await this.requireSource(input.organizationId,input.eventId)
    if(source.session?.status==='completed')throw new EventDayConflictError('Event Day is already completed')
    if(source.event.status==='cancelled'||source.event.status==='completed')throw new EventDayConflictError(`Cannot start Event Day from event status ${source.event.status}`)
    const eventDate=localDate(source.event.startAt,source.timezone)
    const today=localDate(now,source.timezone)
    if(eventDate!==today)throw new EventDayValidationError(`Event Day can only start on the event local date (${eventDate})`)

    const sessionId=source.session?.id??this.newId()
    const session:EventDaySession={
      id:sessionId,organizationId:input.organizationId,eventId:input.eventId,status:'active',startedAt:now,completedAt:null,
      startedBySender:sender,completedBySender:null,createdAt:now,updatedAt:now,
    }
    const activity=this.activity({source,sessionId,type:'event_day.started',at:now,sender,eventVendorId:null,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.started',now,{sessionId,startedBySender:sender})
    const result=await this.deps.store.startSession({session,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async markVendorArrived(input:{organizationId:string;eventId:string;eventVendorId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender);const now=this.now();const source=await this.requireActiveSource(input.organizationId,input.eventId)
    const vendor=requireVendor(source,input.eventVendorId)
    const activity=this.activity({source,sessionId:source.session!.id,type:'vendor.arrived',at:now,sender,eventVendorId:vendor.id,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.vendor_arrived',now,{sessionId:source.session!.id,eventVendorId:vendor.id,vendorName:vendor.vendorName,actualArrivalAt:now.toISOString()})
    const result=await this.deps.store.markVendorArrived({organizationId:input.organizationId,eventId:input.eventId,eventVendorId:vendor.id,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async markVendorDeparted(input:{organizationId:string;eventId:string;eventVendorId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender);const now=this.now();const source=await this.requireActiveSource(input.organizationId,input.eventId)
    const vendor=requireVendor(source,input.eventVendorId)
    if(!vendor.actualArrivalAt)throw new EventDayConflictError('Vendor departure cannot be recorded before arrival')
    const activity=this.activity({source,sessionId:source.session!.id,type:'vendor.departed',at:now,sender,eventVendorId:vendor.id,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.vendor_departed',now,{sessionId:source.session!.id,eventVendorId:vendor.id,vendorName:vendor.vendorName,actualDepartureAt:now.toISOString()})
    const result=await this.deps.store.markVendorDeparted({organizationId:input.organizationId,eventId:input.eventId,eventVendorId:vendor.id,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async complete(input:{organizationId:string;eventId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender);const now=this.now();const source=await this.requireSource(input.organizationId,input.eventId)
    if(!source.session)throw new EventDayConflictError('Event Day has not been started')
    if(source.session.status==='completed')return{snapshot:buildSnapshot(source,now,this.arrivalGraceMinutes,this.criticalLateMinutes),duplicate:true}
    const activity=this.activity({source,sessionId:source.session.id,type:'event_day.completed',at:now,sender,eventVendorId:null,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.completed',now,{sessionId:source.session.id,completedBySender:sender})
    const result=await this.deps.store.completeSession({organizationId:input.organizationId,eventId:input.eventId,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  private async requireSource(organizationId:string,eventId:string):Promise<EventDaySource>{
    if(!organizationId?.trim()||!eventId?.trim())throw new EventDayValidationError('organizationId and eventId are required')
    const source=await this.deps.store.loadSource(organizationId,eventId)
    if(!source)throw new EventDayNotFoundError()
    return source
  }
  private async requireActiveSource(organizationId:string,eventId:string){
    const source=await this.requireSource(organizationId,eventId)
    if(!source.session)throw new EventDayConflictError('Event Day has not been started')
    if(source.session.status!=='active')throw new EventDayConflictError('Event Day is already completed')
    return source
  }
  private activity(input:{source:EventDaySource;sessionId:string;type:EventDayActivityType;at:Date;sender:string;eventVendorId:string|null;note:string|null}):EventDayActivity{return{
    id:this.newId(),organizationId:input.source.organizationId,eventId:input.source.event.id,sessionId:input.sessionId,eventVendorId:input.eventVendorId,
    type:input.type,occurredAt:input.at,createdBySender:input.sender,note:input.note,createdAt:input.at,
  }}
  private domainEvent(organizationId:string,eventId:string,eventType:string,occurredAt:Date,payload:Record<string,unknown>):DomainEvent{return{
    id:this.newId(),organizationId,eventType,aggregateType:'event',aggregateId:eventId,occurredAt,payload:{eventId,...payload},
  }}
}

export function buildEventDaySnapshot(source:EventDaySource,now:Date,arrivalGraceMinutes=15,criticalLateMinutes=30):EventDaySnapshot{
  return buildSnapshot(source,now,arrivalGraceMinutes,criticalLateMinutes)
}

function buildSnapshot(source:EventDaySource,now:Date,arrivalGraceMinutes:number,criticalLateMinutes:number):EventDaySnapshot{
  const vendors=source.vendors.map(v=>vendorSnapshot(v,now,arrivalGraceMinutes))
  const tasks=source.tasks.map(t=>({id:t.id,title:t.title,status:t.status,priority:t.priority,dueAt:t.dueAt.toISOString(),overdue:t.dueAt.getTime()<now.getTime()}))
  const openTasks=tasks.length
  const overdueTasks=tasks.filter(t=>t.overdue).length
  const criticalOpenTasks=tasks.filter(t=>t.priority==='critical').length
  const late=vendors.filter(v=>v.liveStatus==='late')
  const due=vendors.filter(v=>v.liveStatus==='due')
  const declined=vendors.filter(v=>v.confirmationStatus==='declined')
  const unconfirmed=vendors.filter(v=>v.confirmationStatus==='pending'||v.confirmationStatus==='requested')
  const criticalTaskOverdue=tasks.some(t=>t.priority==='critical'&&t.overdue)

  let operationalStatus:EventDayOperationalStatus
  if(source.session?.status==='completed')operationalStatus='completed'
  else if(!source.session)operationalStatus='not_started'
  else if(declined.length>0||criticalTaskOverdue||late.some(v=>v.minutesLate>=criticalLateMinutes))operationalStatus='critical'
  else if(late.length>0||due.length>0||unconfirmed.length>0||criticalOpenTasks>0||overdueTasks>0)operationalStatus='attention'
  else operationalStatus='on_track'

  const timeline=buildTimeline(source)
  const nextActions=buildNextActions(source,vendors,tasks,timeline,now)

  return{
    organizationId:source.organizationId,eventId:source.event.id,eventName:source.event.name,timezone:source.timezone,now:now.toISOString(),operationalStatus,
    session:source.session?{id:source.session.id,status:source.session.status,startedAt:source.session.startedAt.toISOString(),completedAt:source.session.completedAt?.toISOString()??null,startedBySender:source.session.startedBySender,completedBySender:source.session.completedBySender}:null,
    event:{startAt:source.event.startAt.toISOString(),endAt:source.event.endAt?.toISOString()??null,status:source.event.status,venueName:source.event.venueName,venueAddress:source.event.venueAddress,guestCount:source.event.guestCount,healthScore:source.event.healthScore},
    counts:{vendors:vendors.length,arrivedVendors:vendors.filter(v=>v.liveStatus==='arrived'||v.liveStatus==='departed').length,lateVendors:late.length,dueVendors:due.length,unconfirmedVendors:unconfirmed.length,departedVendors:vendors.filter(v=>v.liveStatus==='departed').length,openTasks,overdueTasks,criticalOpenTasks},
    vendors,tasks,timeline,nextActions,
  }
}

function vendorSnapshot(vendor:EventDaySourceVendor,now:Date,arrivalGraceMinutes:number):EventDayVendorSnapshot{
  const liveStatus=vendorStatus(vendor,now,arrivalGraceMinutes)
  const minutesLate=liveStatus==='late'&&vendor.plannedArrivalAt?Math.max(0,Math.floor((now.getTime()-vendor.plannedArrivalAt.getTime())/60000)):0
  return{eventVendorId:vendor.id,vendorName:vendor.vendorName,category:vendor.category,confirmationStatus:vendor.confirmationStatus,
    plannedArrivalAt:vendor.plannedArrivalAt?.toISOString()??null,plannedDepartureAt:vendor.plannedDepartureAt?.toISOString()??null,
    actualArrivalAt:vendor.actualArrivalAt?.toISOString()??null,actualDepartureAt:vendor.actualDepartureAt?.toISOString()??null,liveStatus,minutesLate}
}
function vendorStatus(vendor:EventDaySourceVendor,now:Date,grace:number):EventDayVendorStatus{
  if(vendor.actualDepartureAt)return'departed'
  if(vendor.actualArrivalAt)return'arrived'
  if(!vendor.plannedArrivalAt)return'unscheduled'
  const deltaMinutes=(vendor.plannedArrivalAt.getTime()-now.getTime())/60000
  if(deltaMinutes>grace)return'not_due'
  if(deltaMinutes>=-grace)return'due'
  return'late'
}
function buildTimeline(source:EventDaySource):EventDayTimelineItem[]{
  const items:EventDayTimelineItem[]=[]
  for(const vendor of source.vendors){
    if(vendor.plannedArrivalAt)items.push({at:vendor.plannedArrivalAt.toISOString(),source:'planned',type:'vendor_arrival_planned',title:`Chegada prevista — ${vendor.vendorName}`,detail:vendor.category,eventVendorId:vendor.id})
    if(vendor.plannedDepartureAt)items.push({at:vendor.plannedDepartureAt.toISOString(),source:'planned',type:'vendor_departure_planned',title:`Saída prevista — ${vendor.vendorName}`,detail:vendor.category,eventVendorId:vendor.id})
  }
  items.push({at:source.event.startAt.toISOString(),source:'planned',type:'event_start',title:'Início do evento',detail:source.event.venueName,eventVendorId:null})
  if(source.event.endAt)items.push({at:source.event.endAt.toISOString(),source:'planned',type:'event_end',title:'Fim previsto do evento',detail:null,eventVendorId:null})
  for(const entry of source.activity){
    const vendor=entry.eventVendorId?source.vendors.find(v=>v.id===entry.eventVendorId):null
    const mapped=activityTimeline(entry.type)
    items.push({at:entry.occurredAt.toISOString(),source:'actual',type:mapped,title:activityTitle(entry.type,vendor?.vendorName??null),detail:entry.note,eventVendorId:entry.eventVendorId})
  }
  return items.sort((a,b)=>a.at.localeCompare(b.at)||a.source.localeCompare(b.source))
}
function activityTimeline(type:EventDayActivityType):EventDayTimelineItem['type']{
  if(type==='event_day.started')return'session_started'
  if(type==='vendor.arrived')return'vendor_arrived'
  if(type==='vendor.departed')return'vendor_departed'
  return'session_completed'
}
function activityTitle(type:EventDayActivityType,vendorName:string|null):string{
  if(type==='event_day.started')return'Event Day iniciado'
  if(type==='vendor.arrived')return`Chegada registrada — ${vendorName??'fornecedor'}`
  if(type==='vendor.departed')return`Saída registrada — ${vendorName??'fornecedor'}`
  return'Event Day concluído'
}
function buildNextActions(source:EventDaySource,vendors:EventDayVendorSnapshot[],tasks:Array<{title:string;priority:string;overdue:boolean}>,timeline:EventDayTimelineItem[],now:Date):string[]{
  if(source.session?.status==='completed')return['Evento concluído. Nenhuma ação operacional pendente no Event Day.']
  const result:string[]=[]
  for(const task of tasks.filter(t=>t.priority==='critical'&&t.overdue).slice(0,2))result.push(`Resolver tarefa crítica atrasada: ${task.title}`)
  for(const vendor of vendors.filter(v=>v.liveStatus==='late').sort((a,b)=>b.minutesLate-a.minutesLate).slice(0,3))result.push(`Confirmar chegada de ${vendor.vendorName} — ${vendor.minutesLate} min de atraso`)
  for(const vendor of vendors.filter(v=>v.liveStatus==='due').slice(0,2))result.push(`Acompanhar chegada de ${vendor.vendorName}`)
  if(result.length<5){
    const next=timeline.find(item=>item.source==='planned'&&new Date(item.at).getTime()>now.getTime())
    if(next)result.push(`Próximo marco: ${next.title} às ${localTimeLabel(new Date(next.at),source.timezone)}`)
  }
  if(!result.length)result.push(source.session?'Operação dentro do planejado; acompanhar o próximo marco.':'Inicie o Event Day para registrar a execução ao vivo.')
  return result.slice(0,5)
}
function requireVendor(source:EventDaySource,eventVendorId:string):EventDaySourceVendor{
  const vendor=source.vendors.find(v=>v.id===eventVendorId)
  if(!vendor)throw new EventDayNotFoundError('Event vendor not found')
  return vendor
}
function requiredSender(value:string):string{const sender=value?.trim();if(!sender||sender.length<2)throw new EventDayValidationError('sender must contain at least 2 characters');return sender}
function localDate(date:Date,timeZone:string):string{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date)
  const get=(type:string)=>parts.find(p=>p.type===type)?.value??''
  return`${get('year')}-${get('month')}-${get('day')}`
}
function localTimeLabel(date:Date,timeZone:string):string{return new Intl.DateTimeFormat('pt-BR',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}
function clamp(value:number,min:number,max:number){return Math.max(min,Math.min(max,Math.trunc(value)))}
