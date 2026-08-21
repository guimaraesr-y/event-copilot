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
  type EventDaySourceTask,
  type EventDaySourceVendor,
  type EventDayStore,
  type EventDayTaskKind,
  type EventDayTaskMutationResult,
  type EventDayTaskPriority,
  type EventDayTaskRecord,
  type EventDayTaskSnapshot,
  type EventDayTaskStatus,
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

  async enable(input:{organizationId:string;eventId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender),now=this.now()
    const source=await this.requireSource(input.organizationId,input.eventId)
    if(source.event.status==='cancelled'||source.event.status==='completed')throw new EventDayConflictError(`Cannot enable Event Day from event status ${source.event.status}`)
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.enabled',now,{enabled:true,updatedBySender:sender})
    const result=await this.deps.store.enable({organizationId:input.organizationId,eventId:input.eventId,at:now,sender,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async disable(input:{organizationId:string;eventId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender),now=this.now()
    const source=await this.requireSource(input.organizationId,input.eventId)
    const active=source.session?.status==='active'?source.session:null
    const activity=active?this.activity({source,sessionId:active.id,type:'event_day.completed',at:now,sender,eventVendorId:null,note:'Event Day desativado'}):null
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.disabled',now,{enabled:false,updatedBySender:sender,activeSessionId:active?.id??null})
    const result=await this.deps.store.disable({organizationId:input.organizationId,eventId:input.eventId,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async start(input:{organizationId:string;eventId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender)
    const now=this.now()
    const source=await this.requireSource(input.organizationId,input.eventId)
    if(!source.enabled)throw new EventDayConflictError('Event Day is disabled for this event')
    if(source.session?.status==='active')return{snapshot:buildSnapshot(source,now,this.arrivalGraceMinutes,this.criticalLateMinutes),duplicate:true}
    if(source.event.status==='cancelled'||source.event.status==='completed'||source.event.status==='event_day')throw new EventDayConflictError(`Cannot start Event Day from event status ${source.event.status}`)
    const eventDate=localDate(source.event.startAt,source.timezone)
    const today=localDate(now,source.timezone)
    if(eventDate!==today)throw new EventDayValidationError(`Event Day can only start on the event local date (${eventDate})`)

    const sessionId=this.newId()
    const session:EventDaySession={
      id:sessionId,organizationId:input.organizationId,eventId:input.eventId,status:'active',previousEventStatus:source.event.status,
      startedAt:now,completedAt:null,completionReason:null,startedBySender:sender,completedBySender:null,createdAt:now,updatedAt:now,
    }
    const activity=this.activity({source,sessionId,type:'event_day.started',at:now,sender,eventVendorId:null,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.started',now,{sessionId,startedBySender:sender,previousEventStatus:source.event.status})
    const result=await this.deps.store.startSession({session,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async markVendorArrived(input:{organizationId:string;eventId:string;eventVendorId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender),now=this.now(),source=await this.requireActiveSource(input.organizationId,input.eventId)
    const vendor=requireVendor(source,input.eventVendorId)
    const activity=this.activity({source,sessionId:source.session!.id,type:'vendor.arrived',at:now,sender,eventVendorId:vendor.id,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.vendor_arrived',now,{sessionId:source.session!.id,eventVendorId:vendor.id,vendorName:vendor.vendorName,actualArrivalAt:now.toISOString()})
    const result=await this.deps.store.markVendorArrived({organizationId:input.organizationId,eventId:input.eventId,eventVendorId:vendor.id,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async markVendorDeparted(input:{organizationId:string;eventId:string;eventVendorId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender),now=this.now(),source=await this.requireActiveSource(input.organizationId,input.eventId)
    const vendor=requireVendor(source,input.eventVendorId)
    if(!vendor.actualArrivalAt)throw new EventDayConflictError('Vendor departure cannot be recorded before arrival')
    const activity=this.activity({source,sessionId:source.session!.id,type:'vendor.departed',at:now,sender,eventVendorId:vendor.id,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.vendor_departed',now,{sessionId:source.session!.id,eventVendorId:vendor.id,vendorName:vendor.vendorName,actualDepartureAt:now.toISOString()})
    const result=await this.deps.store.markVendorDeparted({organizationId:input.organizationId,eventId:input.eventId,eventVendorId:vendor.id,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async complete(input:{organizationId:string;eventId:string;sender:string}):Promise<EventDayMutationResult>{
    const sender=requiredSender(input.sender),now=this.now(),source=await this.requireSource(input.organizationId,input.eventId)
    if(!source.enabled)throw new EventDayConflictError('Event Day is disabled for this event')
    if(!source.session)throw new EventDayConflictError('Event Day has not been started')
    if(source.session.status==='completed')return{snapshot:buildSnapshot(source,now,this.arrivalGraceMinutes,this.criticalLateMinutes),duplicate:true}
    const activity=this.activity({source,sessionId:source.session.id,type:'event_day.completed',at:now,sender,eventVendorId:null,note:null})
    const domainEvent=this.domainEvent(input.organizationId,input.eventId,'event_day.completed',now,{sessionId:source.session.id,completedBySender:sender,restoredEventStatus:source.session.previousEventStatus})
    const result=await this.deps.store.completeSession({organizationId:input.organizationId,eventId:input.eventId,at:now,sender,activity,domainEvent})
    return{snapshot:await this.get(input.organizationId,input.eventId),duplicate:result.duplicate}
  }

  async createTask(input:{
    organizationId:string;eventId:string;sender:string;title:string;description?:string|null;kind?:EventDayTaskKind;priority?:EventDayTaskPriority;dueAt?:Date;source?:'manual'|'automation'|'ai'
  }):Promise<EventDayTaskMutationResult>{
    const sender=requiredSender(input.sender),now=this.now(),source=await this.requireEnabledSource(input.organizationId,input.eventId)
    const title=input.title?.trim()
    if(!title||title.length<2)throw new EventDayValidationError('Event Day task title must contain at least 2 characters')
    const kind=input.kind??'operation'
    const priority=input.priority??(kind==='incident'?'high':'normal')
    const dueAt=input.dueAt??(source.session?.status==='active'?now:source.event.startAt)
    if(Number.isNaN(dueAt.getTime()))throw new EventDayValidationError('Event Day task dueAt must be a valid date')
    const task:EventDayTaskRecord={
      id:this.newId(),organizationId:input.organizationId,eventId:input.eventId,title,description:input.description?.trim()||null,kind,status:'pending',priority,
      dueAt,source:input.source??'manual',createdAt:now,updatedAt:now,completedAt:null,
    }
    const domainEvent:DomainEvent={
      id:this.newId(),organizationId:input.organizationId,eventType:'event_day.task_created',aggregateType:'task',aggregateId:task.id,occurredAt:now,
      payload:{eventId:input.eventId,taskId:task.id,title:task.title,kind:task.kind,priority:task.priority,dueAt:task.dueAt.toISOString(),source:task.source,createdBySender:sender},
    }
    await this.deps.store.createTask({task,domainEvent})
    const snapshot=await this.get(input.organizationId,input.eventId)
    return{snapshot,task:requireSnapshotTask(snapshot,task.id),duplicate:false}
  }

  async startTask(input:{organizationId:string;eventId:string;taskId:string;sender:string}):Promise<EventDayTaskMutationResult>{
    return this.changeTaskStatus({...input,status:'in_progress',eventType:'event_day.task_started'})
  }
  async completeTask(input:{organizationId:string;eventId:string;taskId:string;sender:string}):Promise<EventDayTaskMutationResult>{
    return this.changeTaskStatus({...input,status:'completed',eventType:'event_day.task_completed'})
  }
  async cancelTask(input:{organizationId:string;eventId:string;taskId:string;sender:string}):Promise<EventDayTaskMutationResult>{
    return this.changeTaskStatus({...input,status:'cancelled',eventType:'event_day.task_cancelled'})
  }
  async resolveIncident(input:{organizationId:string;eventId:string;taskId:string;sender:string}):Promise<EventDayTaskMutationResult>{
    const source=await this.requireEnabledSource(input.organizationId,input.eventId)
    const task=requireTask(source,input.taskId)
    if(task.kind!=='incident')throw new EventDayValidationError('Only incident tasks can be resolved as incidents')
    return this.changeTaskStatus({...input,status:'completed',eventType:'event_day.incident_resolved'})
  }

  private async changeTaskStatus(input:{organizationId:string;eventId:string;taskId:string;sender:string;status:EventDayTaskStatus;eventType:string}):Promise<EventDayTaskMutationResult>{
    const sender=requiredSender(input.sender),now=this.now(),source=await this.requireEnabledSource(input.organizationId,input.eventId)
    const current=requireTask(source,input.taskId)
    if(current.status==='cancelled'&&input.status!=='cancelled')throw new EventDayConflictError('Cancelled Event Day task cannot be reopened')
    if(current.status==='completed'&&input.status!=='completed')throw new EventDayConflictError('Completed Event Day task cannot be reopened')
    const domainEvent:DomainEvent={
      id:this.newId(),organizationId:input.organizationId,eventType:input.eventType,aggregateType:'task',aggregateId:current.id,occurredAt:now,
      payload:{eventId:input.eventId,taskId:current.id,title:current.title,kind:current.kind,previousStatus:current.status,status:input.status,updatedBySender:sender},
    }
    const result=await this.deps.store.updateTask({organizationId:input.organizationId,eventId:input.eventId,taskId:input.taskId,status:input.status,at:now,sender,domainEvent})
    const snapshot=await this.get(input.organizationId,input.eventId)
    return{snapshot,task:requireSnapshotTask(snapshot,result.task.id),duplicate:result.duplicate}
  }

  private async requireSource(organizationId:string,eventId:string):Promise<EventDaySource>{
    if(!organizationId?.trim()||!eventId?.trim())throw new EventDayValidationError('organizationId and eventId are required')
    const source=await this.deps.store.loadSource(organizationId,eventId)
    if(!source)throw new EventDayNotFoundError()
    return source
  }
  private async requireEnabledSource(organizationId:string,eventId:string):Promise<EventDaySource>{
    const source=await this.requireSource(organizationId,eventId)
    if(!source.enabled)throw new EventDayConflictError('Event Day is disabled for this event')
    return source
  }
  private async requireActiveSource(organizationId:string,eventId:string){
    const source=await this.requireEnabledSource(organizationId,eventId)
    if(!source.session||source.session.status!=='active')throw new EventDayConflictError('Event Day has not been started')
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
  const tasks=source.tasks.map(t=>taskSnapshot(t,now))
  const openTasks=tasks.filter(isOpenTask)
  const overdueTasks=openTasks.filter(t=>t.overdue)
  const criticalOpenTasks=openTasks.filter(t=>t.priority==='critical')
  const incidents=tasks.filter(t=>t.kind==='incident')
  const openIncidents=incidents.filter(isOpenTask)
  const criticalOpenIncidents=openIncidents.filter(t=>t.priority==='critical')
  const resolvedIncidents=incidents.filter(t=>t.status==='completed')
  const late=vendors.filter(v=>v.liveStatus==='late')
  const due=vendors.filter(v=>v.liveStatus==='due')
  const declined=vendors.filter(v=>v.confirmationStatus==='declined')
  const unconfirmed=vendors.filter(v=>v.confirmationStatus==='pending'||v.confirmationStatus==='requested')
  const criticalTaskOverdue=criticalOpenTasks.some(t=>t.overdue)

  let operationalStatus:EventDayOperationalStatus
  if(!source.enabled)operationalStatus='disabled'
  else if(source.session?.status==='completed')operationalStatus='completed'
  else if(!source.session)operationalStatus='not_started'
  else if(criticalOpenIncidents.length>0||declined.length>0||criticalTaskOverdue||late.some(v=>v.minutesLate>=criticalLateMinutes))operationalStatus='critical'
  else if(openIncidents.length>0||late.length>0||due.length>0||unconfirmed.length>0||criticalOpenTasks.length>0||overdueTasks.length>0)operationalStatus='attention'
  else operationalStatus='on_track'

  const timeline=buildTimeline(source)
  const nextActions=buildNextActions(source,vendors,tasks,timeline,now)

  return{
    organizationId:source.organizationId,eventId:source.event.id,eventName:source.event.name,timezone:source.timezone,now:now.toISOString(),enabled:source.enabled,operationalStatus,
    session:source.session?{id:source.session.id,status:source.session.status,previousEventStatus:source.session.previousEventStatus,startedAt:source.session.startedAt.toISOString(),completedAt:source.session.completedAt?.toISOString()??null,completionReason:source.session.completionReason,startedBySender:source.session.startedBySender,completedBySender:source.session.completedBySender}:null,
    event:{startAt:source.event.startAt.toISOString(),endAt:source.event.endAt?.toISOString()??null,status:source.event.status,venueName:source.event.venueName,venueAddress:source.event.venueAddress,guestCount:source.event.guestCount,healthScore:source.event.healthScore},
    counts:{vendors:vendors.length,arrivedVendors:vendors.filter(v=>v.liveStatus==='arrived'||v.liveStatus==='departed').length,lateVendors:late.length,dueVendors:due.length,unconfirmedVendors:unconfirmed.length,departedVendors:vendors.filter(v=>v.liveStatus==='departed').length,tasks:tasks.length,openTasks:openTasks.length,overdueTasks:overdueTasks.length,criticalOpenTasks:criticalOpenTasks.length,incidents:incidents.length,openIncidents:openIncidents.length,criticalOpenIncidents:criticalOpenIncidents.length,resolvedIncidents:resolvedIncidents.length},
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
function taskSnapshot(task:EventDaySourceTask,now:Date):EventDayTaskSnapshot{
  const open=task.status==='pending'||task.status==='in_progress'
  return{id:task.id,title:task.title,description:task.description,kind:task.kind,status:task.status,priority:task.priority,dueAt:task.dueAt.toISOString(),overdue:open&&task.dueAt.getTime()<now.getTime(),source:task.source,createdAt:task.createdAt.toISOString(),updatedAt:task.updatedAt.toISOString(),completedAt:task.completedAt?.toISOString()??null}
}
function isOpenTask(task:EventDayTaskSnapshot):boolean{return task.status==='pending'||task.status==='in_progress'}
function buildTimeline(source:EventDaySource):EventDayTimelineItem[]{
  const items:EventDayTimelineItem[]=[]
  for(const vendor of source.vendors){
    if(vendor.plannedArrivalAt)items.push({at:vendor.plannedArrivalAt.toISOString(),source:'planned',type:'vendor_arrival_planned',title:`Chegada prevista — ${vendor.vendorName}`,detail:vendor.category,eventVendorId:vendor.id,taskId:null})
    if(vendor.plannedDepartureAt)items.push({at:vendor.plannedDepartureAt.toISOString(),source:'planned',type:'vendor_departure_planned',title:`Saída prevista — ${vendor.vendorName}`,detail:vendor.category,eventVendorId:vendor.id,taskId:null})
  }
  for(const task of source.tasks.filter(t=>t.status!=='cancelled'))items.push({at:task.dueAt.toISOString(),source:'planned',type:'task_due',title:`Task — ${task.title}`,detail:task.kind,eventVendorId:null,taskId:task.id})
  items.push({at:source.event.startAt.toISOString(),source:'planned',type:'event_start',title:'Início do evento',detail:source.event.venueName,eventVendorId:null,taskId:null})
  if(source.event.endAt)items.push({at:source.event.endAt.toISOString(),source:'planned',type:'event_end',title:'Fim previsto do evento',detail:null,eventVendorId:null,taskId:null})
  for(const entry of source.activity){
    const vendor=entry.eventVendorId?source.vendors.find(v=>v.id===entry.eventVendorId):null
    const mapped=activityTimeline(entry.type)
    items.push({at:entry.occurredAt.toISOString(),source:'actual',type:mapped,title:activityTitle(entry.type,vendor?.vendorName??null,entry.note),detail:entry.note,eventVendorId:entry.eventVendorId,taskId:null})
  }
  return items.sort((a,b)=>a.at.localeCompare(b.at)||a.source.localeCompare(b.source))
}
function activityTimeline(type:EventDayActivityType):EventDayTimelineItem['type']{
  if(type==='event_day.started')return'session_started'
  if(type==='vendor.arrived')return'vendor_arrived'
  if(type==='vendor.departed')return'vendor_departed'
  return'session_completed'
}
function activityTitle(type:EventDayActivityType,vendorName:string|null,note:string|null):string{
  if(type==='event_day.started')return'Event Day iniciado'
  if(type==='vendor.arrived')return`Chegada registrada — ${vendorName??'fornecedor'}`
  if(type==='vendor.departed')return`Saída registrada — ${vendorName??'fornecedor'}`
  return note==='Event Day desativado'?'Event Day desativado':'Sessão Event Day concluída'
}
function buildNextActions(source:EventDaySource,vendors:EventDayVendorSnapshot[],tasks:EventDayTaskSnapshot[],timeline:EventDayTimelineItem[],now:Date):string[]{
  if(!source.enabled)return['Event Day desativado para este evento. A operação ao vivo não interfere no planejamento dos demais eventos.']
  if(source.session?.status==='completed')return['Sessão Event Day encerrada. O evento permanece disponível no fluxo normal de planejamento/conclusão.']
  if(!source.session)return['Inicie o Event Day quando a operação presencial começar.']
  const result:string[]=[]
  const open=tasks.filter(isOpenTask)
  for(const incident of open.filter(t=>t.kind==='incident').sort(taskPrioritySort).slice(0,3))result.push(`Resolver incidente${incident.priority==='critical'?' crítico':''}: ${incident.title}`)
  for(const task of open.filter(t=>t.kind!=='incident'&&t.priority==='critical'&&t.overdue).slice(0,2))result.push(`Resolver tarefa crítica atrasada: ${task.title}`)
  for(const vendor of vendors.filter(v=>v.liveStatus==='late').sort((a,b)=>b.minutesLate-a.minutesLate).slice(0,3))result.push(`Confirmar chegada de ${vendor.vendorName} — ${vendor.minutesLate} min de atraso`)
  for(const vendor of vendors.filter(v=>v.liveStatus==='due').slice(0,2))result.push(`Acompanhar chegada de ${vendor.vendorName}`)
  for(const task of open.filter(t=>t.kind!=='incident').sort((a,b)=>a.dueAt.localeCompare(b.dueAt)).slice(0,2)){
    if(result.length>=5)break
    result.push(`${task.status==='in_progress'?'Concluir':'Executar'}: ${task.title}`)
  }
  if(result.length<5){
    const next=timeline.find(item=>item.source==='planned'&&new Date(item.at).getTime()>now.getTime())
    if(next)result.push(`Próximo marco: ${next.title} às ${localTimeLabel(new Date(next.at),source.timezone)}`)
  }
  if(!result.length)result.push('Operação dentro do planejado; acompanhar o próximo marco.')
  return [...new Set(result)].slice(0,5)
}
function taskPrioritySort(a:EventDayTaskSnapshot,b:EventDayTaskSnapshot):number{return priorityWeight(b.priority)-priorityWeight(a.priority)||a.dueAt.localeCompare(b.dueAt)}
function priorityWeight(value:EventDayTaskPriority):number{return value==='critical'?4:value==='high'?3:value==='normal'?2:1}
function requireVendor(source:EventDaySource,eventVendorId:string):EventDaySourceVendor{
  const vendor=source.vendors.find(v=>v.id===eventVendorId)
  if(!vendor)throw new EventDayNotFoundError('Event vendor not found')
  return vendor
}
function requireTask(source:EventDaySource,taskId:string):EventDaySourceTask{
  const task=source.tasks.find(t=>t.id===taskId)
  if(!task)throw new EventDayNotFoundError('Event Day task not found')
  return task
}
function requireSnapshotTask(snapshot:EventDaySnapshot,taskId:string):EventDayTaskSnapshot{
  const task=snapshot.tasks.find(t=>t.id===taskId)
  if(!task)throw new EventDayNotFoundError('Event Day task not found after mutation')
  return task
}
function requiredSender(value:string):string{const sender=value?.trim();if(!sender||sender.length<2)throw new EventDayValidationError('sender must contain at least 2 characters');return sender}
function localDate(date:Date,timeZone:string):string{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date)
  const get=(type:string)=>parts.find(p=>p.type===type)?.value??''
  return`${get('year')}-${get('month')}-${get('day')}`
}
function localTimeLabel(date:Date,timeZone:string):string{return new Intl.DateTimeFormat('pt-BR',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}
function clamp(value:number,min:number,max:number){return Math.max(min,Math.min(max,Math.trunc(value)))}
