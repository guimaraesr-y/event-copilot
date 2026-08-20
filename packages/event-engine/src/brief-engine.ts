import type {
  BriefEventSummary,
  BriefPreference,
  BriefPriorityItem,
  BriefSchedule,
  BriefSnapshotTask,
  BriefStore,
  BriefType,
  DailyBrief,
  DailyBriefSnapshot,
  DMinus1Brief,
  DMinus1BriefSnapshot,
  DMinus1BriefSummary,
  EventReadinessStatus,
} from '@ecc/domain'
import { BriefNotFoundError, BriefValidationError, healthStatusForScore } from '@ecc/domain'
import { localDateTimeToUtc, partsInTimeZone } from './schedule.ts'

export interface BriefEngineDependencies { store:BriefStore; now?:()=>Date; newId?:()=>string }
export interface GenerateDailyBriefInput {
  organizationId:string
  triggerType:'scheduled'|'manual'|'agent'
  triggerKey:string
  referenceDate?:string
  requestDelivery?:boolean
  generatedBySender?:string|null
  recipient?:string|null
  at?:Date
}
export interface GenerateDMinus1BriefInput extends GenerateDailyBriefInput { eventId:string }

export class BriefEngine {
  private readonly now:()=>Date
  private readonly newId:()=>string
  constructor(private readonly deps:BriefEngineDependencies){this.now=deps.now??(()=>new Date());this.newId=deps.newId??(()=>crypto.randomUUID())}

  async getPreference(organizationId:string):Promise<BriefPreference>{return this.deps.store.getPreference(requiredId(organizationId,'organizationId'))}
  async getSchedule(organizationId:string,type:BriefType):Promise<BriefSchedule>{return this.deps.store.getSchedule(requiredId(organizationId,'organizationId'),type)}

  async configurePreference(input:{organizationId:string;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;fallbackRecipient?:string|null}):Promise<BriefPreference>{
    const configured=await this.configureSchedule({...input,type:'daily'})
    const {type:_type,...pref}=configured
    return pref
  }

  async configureSchedule(input:{organizationId:string;type:BriefType;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;fallbackRecipient?:string|null}):Promise<BriefSchedule>{
    const organizationId=requiredId(input.organizationId,'organizationId')
    if(input.localTime!==undefined&&!isTime(input.localTime))throw new BriefValidationError('localTime must use HH:mm format')
    const current=await this.deps.store.getSchedule(organizationId,input.type)
    let recipient=input.recipient!==undefined?normalizeRecipient(input.recipient):current.recipient
    const enabled=input.enabled??current.enabled
    if(enabled&&!recipient&&input.fallbackRecipient)recipient=normalizeRecipient(input.fallbackRecipient)
    if(enabled&&!recipient)throw new BriefValidationError(`A WhatsApp recipient is required before enabling the ${input.type==='daily'?'daily brief':'D-1 brief'}`)
    return this.deps.store.updateSchedule({organizationId,type:input.type,enabled,localTime:input.localTime,recipient,updatedBySender:input.updatedBySender,at:this.now()})
  }

  async generateDaily(input:GenerateDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>{
    const organizationId=requiredId(input.organizationId,'organizationId')
    if(!input.triggerKey.trim())throw new BriefValidationError('triggerKey is required')
    const at=input.at??this.now()
    const snapshot=await this.deps.store.loadDailySnapshot(organizationId)
    if(!snapshot)throw new BriefNotFoundError('Organization not found for daily brief')
    const referenceDate=input.referenceDate??localDate(at,snapshot.timezone)
    assertReferenceDate(referenceDate)
    const summary=buildSummary(snapshot,referenceDate)
    const renderedText=renderDailyBrief(snapshot.organizationName,summary)
    const requestDelivery=input.requestDelivery??false
    const recipient=await this.resolveDeliveryRecipient(organizationId,'daily',requestDelivery,input.recipient)
    const id=this.newId()
    const domainEvent=requestDelivery?this.deliveryEvent({id,organizationId,type:'daily',eventId:null,eventName:null,referenceDate,recipient:recipient!,renderedText,at}):null
    return this.deps.store.persistDaily({
      brief:{id,organizationId,type:'daily',eventId:null,referenceDate,triggerType:input.triggerType,triggerKey:input.triggerKey,summary,renderedText,generatedBySender:input.generatedBySender??null,generatedAt:at,deliveryRequestedAt:requestDelivery?at:null},
      requestDelivery,recipient,domainEvent,
    })
  }

  async generateDMinus1(input:GenerateDMinus1BriefInput):Promise<{brief:DMinus1Brief;duplicate:boolean}>{
    const organizationId=requiredId(input.organizationId,'organizationId')
    const eventId=requiredId(input.eventId,'eventId')
    if(!input.triggerKey.trim())throw new BriefValidationError('triggerKey is required')
    const at=input.at??this.now()
    const snapshot=await this.deps.store.loadDMinus1Snapshot(organizationId,eventId)
    if(!snapshot)throw new BriefNotFoundError('Event not found for D-1 brief')
    const referenceDate=input.referenceDate??localDate(at,snapshot.timezone)
    assertReferenceDate(referenceDate)
    const summary=buildDMinus1Summary(snapshot,referenceDate,at)
    const renderedText=renderDMinus1Brief(snapshot.organizationName,summary)
    const requestDelivery=input.requestDelivery??false
    const recipient=await this.resolveDeliveryRecipient(organizationId,'d_minus_1',requestDelivery,input.recipient)
    const id=this.newId()
    const domainEvent=requestDelivery?this.deliveryEvent({id,organizationId,type:'d_minus_1',eventId,eventName:snapshot.event.name,referenceDate,recipient:recipient!,renderedText,at}):null
    return this.deps.store.persistDMinus1({
      brief:{id,organizationId,type:'d_minus_1',eventId,referenceDate,triggerType:input.triggerType,triggerKey:input.triggerKey,summary,renderedText,generatedBySender:input.generatedBySender??null,generatedAt:at,deliveryRequestedAt:requestDelivery?at:null},
      requestDelivery,recipient,domainEvent,
    })
  }

  async getToday(organizationId:string,at=this.now()):Promise<DailyBrief>{
    const snapshot=await this.deps.store.loadDailySnapshot(requiredId(organizationId,'organizationId'))
    if(!snapshot)throw new BriefNotFoundError('Organization not found for daily brief')
    const brief=await this.deps.store.getLatestDaily(organizationId,localDate(at,snapshot.timezone))
    if(!brief)throw new BriefNotFoundError('Daily brief has not been generated yet')
    return brief
  }
  async getDMinus1(organizationId:string,eventId:string):Promise<DMinus1Brief>{const value=await this.deps.store.getLatestDMinus1(requiredId(organizationId,'organizationId'),requiredId(eventId,'eventId'));if(!value)throw new BriefNotFoundError('D-1 brief has not been generated yet for this event');return value}
  async get(organizationId:string,briefId:string){const value=await this.deps.store.getById(requiredId(organizationId,'organizationId'),requiredId(briefId,'briefId'));if(!value)throw new BriefNotFoundError();return value}
  list(organizationId:string,limit=30):Promise<DailyBrief[]>{return this.deps.store.listDaily(requiredId(organizationId,'organizationId'),clamp(limit,1,100))}
  listDMinus1(organizationId:string,eventId?:string,limit=30):Promise<DMinus1Brief[]>{return this.deps.store.listDMinus1(requiredId(organizationId,'organizationId'),eventId,clamp(limit,1,100))}

  async processDueSchedules(at=this.now()):Promise<{generated:number;duplicates:number;daily:number;dMinus1:number;failed:Array<{organizationId:string;type:BriefType;error:string}>}> {
    const schedules=await this.deps.store.listScheduledSchedules()
    let generated=0,duplicates=0,daily=0,dMinus1=0
    const failed:Array<{organizationId:string;type:BriefType;error:string}>=[]
    for(const schedule of schedules){
      try{
        const parts=partsInTimeZone(at,schedule.timezone)
        const currentMinutes=parts.hour*60+parts.minute
        const [hour,minute]=schedule.localTime.split(':').map(Number)
        if(currentMinutes<hour*60+minute)continue
        const referenceDate=formatDate(parts.year,parts.month,parts.day)
        if(schedule.type==='daily'){
          const result=await this.generateDaily({organizationId:schedule.organizationId,triggerType:'scheduled',triggerKey:`scheduled:daily:${referenceDate}`,referenceDate,requestDelivery:true,recipient:schedule.recipient,generatedBySender:'operational_agent',at})
          if(result.duplicate)duplicates++;else{generated++;daily++}
          continue
        }
        const dailySnapshot=await this.deps.store.loadDailySnapshot(schedule.organizationId)
        if(!dailySnapshot)throw new BriefNotFoundError('Organization not found for D-1 scheduling')
        const targetDate=addLocalDays(referenceDate,1)
        const events=dailySnapshot.events.filter(event=>localDate(event.startAt,schedule.timezone)===targetDate)
        for(const event of events){
          const result=await this.generateDMinus1({organizationId:schedule.organizationId,eventId:event.id,triggerType:'scheduled',triggerKey:`scheduled:d_minus_1:${event.id}:${targetDate}`,referenceDate,requestDelivery:true,recipient:schedule.recipient,generatedBySender:'operational_agent',at})
          if(result.duplicate)duplicates++;else{generated++;dMinus1++}
        }
      }catch(error){failed.push({organizationId:schedule.organizationId,type:schedule.type,error:error instanceof Error?error.message:String(error)})}
    }
    return{generated,duplicates,daily,dMinus1,failed}
  }

  private async resolveDeliveryRecipient(organizationId:string,type:BriefType,requestDelivery:boolean,inputRecipient:string|null|undefined):Promise<string|null>{
    let recipient=inputRecipient!==undefined?normalizeRecipient(inputRecipient):null
    if(requestDelivery&&!recipient){const schedule=await this.deps.store.getSchedule(organizationId,type);recipient=schedule.recipient}
    if(requestDelivery&&!recipient)throw new BriefValidationError(`${type==='daily'?'Daily':'D-1'} brief delivery requires a WhatsApp recipient`)
    return recipient
  }

  private deliveryEvent(input:{id:string;organizationId:string;type:BriefType;eventId:string|null;eventName:string|null;referenceDate:string;recipient:string;renderedText:string;at:Date}){
    const messageType=input.type==='daily'?'daily_brief':'d_minus_1_brief'
    return{
      id:this.newId(),organizationId:input.organizationId,eventType:'brief.delivery_requested',aggregateType:'brief',aggregateId:input.id,occurredAt:input.at,
      payload:{briefId:input.id,briefType:input.type,eventId:input.eventId,eventName:input.eventName,referenceDate:input.referenceDate,recipient:input.recipient,text:input.renderedText,channel:'whatsapp',messageType,source:'brief_engine'},
    }
  }
}

function buildSummary(snapshot:DailyBriefSnapshot,referenceDate:string){
  const {start,end}=localDayRange(referenceDate,snapshot.timezone)
  const events:BriefEventSummary[]=snapshot.events.map(event=>{
    const tasks=snapshot.tasks.filter(x=>x.eventId===event.id)
    const vendors=snapshot.vendors.filter(x=>x.eventId===event.id)
    const risks=snapshot.risks.filter(x=>x.eventId===event.id)
    const dependencies=snapshot.dependencies.filter(x=>x.eventId===event.id)
    const changes=snapshot.changes.filter(x=>x.eventId===event.id)
    const inbox=snapshot.inbox.filter(x=>x.eventId===event.id)
    const overdue=tasks.filter(t=>t.dueAt<start)
    const dueToday=tasks.filter(t=>t.dueAt>=start&&t.dueAt<end)
    const criticalRisks=risks.filter(r=>r.severity==='critical').length
    const highRisks=risks.filter(r=>r.severity==='high').length
    const declined=vendors.filter(v=>v.confirmationStatus==='declined').length
    const pending=vendors.filter(v=>v.confirmationStatus==='pending'||v.confirmationStatus==='requested').length
    const criticalInbox=inbox.filter(i=>i.severity==='critical').length
    const priorityScore=Math.min(100,Math.round((100-event.healthScore)*0.45+criticalRisks*20+highRisks*12+Math.min(24,overdue.length*6)+Math.min(12,dueToday.length*4)+declined*18+Math.min(15,dependencies.length*5)+criticalInbox*10))
    return{eventId:event.id,eventName:event.name,eventStartAt:event.startAt.toISOString(),daysUntil:daysBetweenLocal(referenceDate,event.startAt,snapshot.timezone),healthScore:event.healthScore,healthStatus:healthStatusForScore(event.healthScore),priorityScore,activeRisks:risks.length,criticalRisks,highRisks,overdueTasks:overdue.length,dueTodayTasks:dueToday.length,pendingVendors:pending,declinedVendors:declined,openDependencies:dependencies.length,pendingChanges:changes.length,openInbox:inbox.length}
  }).sort((a,b)=>b.priorityScore-a.priorityScore||a.healthScore-b.healthScore||a.eventStartAt.localeCompare(b.eventStartAt))
  const priorities=buildPriorities(snapshot,start,end).slice(0,10).map((item,index)=>({...item,rank:index+1}))
  return{referenceDate,timezone:snapshot.timezone,activeEvents:events.length,criticalEvents:events.filter(e=>e.healthStatus==='critical').length,attentionEvents:events.filter(e=>e.healthStatus==='attention').length,overdueTasks:events.reduce((s,e)=>s+e.overdueTasks,0),dueTodayTasks:events.reduce((s,e)=>s+e.dueTodayTasks,0),pendingVendors:events.reduce((s,e)=>s+e.pendingVendors,0),openDependencies:events.reduce((s,e)=>s+e.openDependencies,0),pendingChanges:events.reduce((s,e)=>s+e.pendingChanges,0),openInbox:snapshot.inbox.length,events,priorities}
}

export function buildDMinus1Summary(snapshot:DMinus1BriefSnapshot,referenceDate:string,at:Date):DMinus1BriefSummary{
  const overdue=(date:Date)=>date.getTime()<at.getTime()
  const criticalRisks=snapshot.risks.filter(r=>r.severity==='critical')
  const highRisks=snapshot.risks.filter(r=>r.severity==='high')
  const criticalOpenTasks=snapshot.tasks.filter(t=>t.priority==='critical')
  const overdueTasks=snapshot.tasks.filter(t=>overdue(t.dueAt))
  const confirmedVendors=snapshot.vendors.filter(v=>v.confirmationStatus==='confirmed')
  const pendingVendors=snapshot.vendors.filter(v=>v.confirmationStatus==='pending'||v.confirmationStatus==='requested')
  const declinedVendors=snapshot.vendors.filter(v=>v.confirmationStatus==='declined')
  const criticalDependencies=snapshot.dependencies.filter(d=>d.severity==='critical')
  const criticalInbox=snapshot.inbox.filter(i=>i.severity==='critical')
  const blocking:string[]=[]
  if(criticalRisks.length)blocking.push(`${criticalRisks.length} risco(s) crítico(s) ativo(s)`)
  if(declinedVendors.length)blocking.push(`${declinedVendors.length} fornecedor(es) recusado(s)`)
  if(criticalOpenTasks.length)blocking.push(`${criticalOpenTasks.length} tarefa(s) crítica(s) ainda aberta(s)`)
  if(criticalDependencies.length)blocking.push(`${criticalDependencies.length} dependência(s) crítica(s) aberta(s)`)
  if(snapshot.changes.length)blocking.push(`${snapshot.changes.length} mudança(s) sensível(is) aguardando decisão`)
  if(criticalInbox.length)blocking.push(`${criticalInbox.length} item(ns) crítico(s) na caixa operacional`)
  const warnings:string[]=[]
  if(highRisks.length)warnings.push(`${highRisks.length} risco(s) alto(s)`)
  if(pendingVendors.length)warnings.push(`${pendingVendors.length} fornecedor(es) aguardando confirmação`)
  if(overdueTasks.length)warnings.push(`${overdueTasks.length} tarefa(s) atrasada(s)`)
  if(snapshot.milestones.length)warnings.push(`${snapshot.milestones.length} milestone(s) ainda aberto(s)`)
  if(snapshot.dependencies.length)warnings.push(`${snapshot.dependencies.length} dependência(s) aberta(s)`)
  if(snapshot.inbox.length)warnings.push(`${snapshot.inbox.length} item(ns) na caixa operacional`)
  const readiness:EventReadinessStatus=blocking.length?'NOT_READY':warnings.length?'READY_WITH_WARNINGS':'READY'
  const reasons=blocking.length?blocking:warnings
  const timeline=buildDMinus1Timeline(snapshot)
  return{
    referenceDate,timezone:snapshot.timezone,readiness,readinessReasons:reasons,
    event:{eventId:snapshot.event.id,eventName:snapshot.event.name,startAt:snapshot.event.startAt.toISOString(),endAt:snapshot.event.endAt?.toISOString()??null,venueName:snapshot.event.venueName,venueAddress:snapshot.event.venueAddress,guestCount:snapshot.event.guestCount,healthScore:snapshot.event.healthScore,healthStatus:healthStatusForScore(snapshot.event.healthScore)},
    counts:{activeRisks:snapshot.risks.length,criticalRisks:criticalRisks.length,highRisks:highRisks.length,openTasks:snapshot.tasks.length,overdueTasks:overdueTasks.length,criticalOpenTasks:criticalOpenTasks.length,openMilestones:snapshot.milestones.length,confirmedVendors:confirmedVendors.length,pendingVendors:pendingVendors.length,declinedVendors:declinedVendors.length,openDependencies:snapshot.dependencies.length,pendingChanges:snapshot.changes.length,openInbox:snapshot.inbox.length},
    risks:[...snapshot.risks].sort((a,b)=>b.score-a.score).map(r=>({id:r.id,severity:r.severity,score:r.score,title:r.title,status:r.status})),
    tasks:[...snapshot.tasks].sort((a,b)=>a.dueAt.getTime()-b.dueAt.getTime()).map(t=>({id:t.id,title:t.title,priority:t.priority,dueAt:t.dueAt.toISOString(),overdue:overdue(t.dueAt)})),
    milestones:[...snapshot.milestones].sort((a,b)=>a.dueAt.getTime()-b.dueAt.getTime()).map(m=>({id:m.id,name:m.name,dueAt:m.dueAt.toISOString(),status:m.status,overdue:overdue(m.dueAt)})),
    vendors:[...snapshot.vendors].sort((a,b)=>(a.arrivalAt?.getTime()??Number.MAX_SAFE_INTEGER)-(b.arrivalAt?.getTime()??Number.MAX_SAFE_INTEGER)).map(v=>({id:v.id,vendorName:v.vendorName,category:v.category,confirmationStatus:v.confirmationStatus,arrivalAt:v.arrivalAt?.toISOString()??null,departureAt:v.departureAt?.toISOString()??null})),
    dependencies:snapshot.dependencies.map(d=>({id:d.id,severity:d.severity,title:d.title})),changes:snapshot.changes.map(c=>({id:c.id,type:c.type})),inbox:snapshot.inbox.map(i=>({id:i.id,severity:i.severity,title:i.title})),timeline,
  }
}

function buildDMinus1Timeline(snapshot:DMinus1BriefSnapshot){
  const items:DMinus1BriefSummary['timeline']=[]
  for(const vendor of snapshot.vendors){if(vendor.arrivalAt)items.push({at:vendor.arrivalAt.toISOString(),type:'vendor_arrival',title:`Chegada — ${vendor.vendorName}`,detail:vendor.category});if(vendor.departureAt)items.push({at:vendor.departureAt.toISOString(),type:'vendor_departure',title:`Saída — ${vendor.vendorName}`,detail:vendor.category})}
  items.push({at:snapshot.event.startAt.toISOString(),type:'event_start',title:`Início — ${snapshot.event.name}`,detail:snapshot.event.venueName})
  if(snapshot.event.endAt)items.push({at:snapshot.event.endAt.toISOString(),type:'event_end',title:`Fim — ${snapshot.event.name}`,detail:snapshot.event.venueName})
  return items.sort((a,b)=>a.at.localeCompare(b.at))
}

function buildPriorities(snapshot:DailyBriefSnapshot,start:Date,end:Date):Omit<BriefPriorityItem,'rank'>[]{
  const names=new Map(snapshot.events.map(e=>[e.id,e.name] as const));const items:Omit<BriefPriorityItem,'rank'>[]=[]
  for(const risk of snapshot.risks){items.push({type:'risk',eventId:risk.eventId,eventName:names.get(risk.eventId)??'Evento',sourceId:risk.id,severity:risk.severity,score:risk.score,title:risk.title,reason:risk.description})}
  for(const task of snapshot.tasks){if(task.dueAt>=end)continue;const overdue=task.dueAt<start;items.push({type:'task',eventId:task.eventId,eventName:names.get(task.eventId)??'Evento',sourceId:task.id,severity:task.priority==='critical'?'critical':task.priority==='high'?'high':'normal',score:taskScore(task,overdue),title:task.title,reason:overdue?'Tarefa atrasada':'Tarefa vence hoje'})}
  for(const dep of snapshot.dependencies){items.push({type:'dependency',eventId:dep.eventId,eventName:names.get(dep.eventId)??'Evento',sourceId:dep.id,severity:dep.severity==='critical'?'critical':dep.severity==='warning'?'high':'normal',score:dep.severity==='critical'?88:dep.severity==='warning'?72:55,title:dep.title,reason:'Dependência aberta após mudança operacional'})}
  for(const vendor of snapshot.vendors.filter(v=>v.confirmationStatus==='declined')){items.push({type:'vendor',eventId:vendor.eventId,eventName:names.get(vendor.eventId)??'Evento',sourceId:vendor.id,severity:'critical',score:90,title:`${vendor.vendorName} recusou participação`,reason:'Fornecedor recusado precisa de ação'})}
  for(const change of snapshot.changes){items.push({type:'change',eventId:change.eventId,eventName:names.get(change.eventId)??'Evento',sourceId:change.id,severity:'normal',score:58,title:'Mudança sensível aguardando decisão',reason:`Proposta ${change.type} ainda está pendente`})}
  return dedupe(items).sort((a,b)=>b.score-a.score)
}

function dedupe(items:Omit<BriefPriorityItem,'rank'>[]){const seen=new Set<string>();return items.filter(item=>{const k=`${item.type}:${item.sourceId??item.title}`;if(seen.has(k))return false;seen.add(k);return true})}
function taskScore(task:BriefSnapshotTask,overdue:boolean):number{const weight=task.priority==='critical'?20:task.priority==='high'?12:task.priority==='normal'?6:2;return Math.min(95,(overdue?70:55)+weight)}

export function renderDailyBrief(_organizationName:string,summary:ReturnType<typeof buildSummary>):string{
  const lines=[`Bom dia! Brief operacional de ${summary.referenceDate}.`,'']
  if(summary.activeEvents===0)return`${lines[0]}\n\nNenhum evento ativo no momento.`
  lines.push(`${summary.activeEvents} evento(s) ativo(s) · ${summary.overdueTasks} tarefa(s) atrasada(s) · ${summary.pendingVendors} fornecedor(es) pendente(s).`,'')
  for(const event of summary.events.slice(0,5)){
    const icon=event.healthStatus==='critical'?'🔴':event.healthStatus==='attention'?'🟠':'🟢'
    lines.push(`${icon} ${event.eventName} — ${event.healthScore}/100`)
    const facts=[] as string[]
    if(event.criticalRisks)facts.push(`${event.criticalRisks} risco(s) crítico(s)`)
    if(event.highRisks)facts.push(`${event.highRisks} risco(s) alto(s)`)
    if(event.overdueTasks)facts.push(`${event.overdueTasks} tarefa(s) atrasada(s)`)
    if(event.dueTodayTasks)facts.push(`${event.dueTodayTasks} tarefa(s) hoje`)
    if(event.openDependencies)facts.push(`${event.openDependencies} dependência(s)`)
    if(facts.length)lines.push(`• ${facts.join(' · ')}`)
  }
  if(summary.priorities.length){lines.push('','Prioridades de hoje:');for(const item of summary.priorities.slice(0,5))lines.push(`${item.rank}. ${item.title} — ${item.eventName}`)}
  lines.push('','Se quiser, posso detalhar qualquer evento ou prioridade.')
  return lines.join('\n')
}

export function renderDMinus1Brief(_organizationName:string,summary:DMinus1BriefSummary):string{
  const icon=summary.readiness==='READY'?'🟢':summary.readiness==='READY_WITH_WARNINGS'?'🟠':'🔴'
  const label=summary.readiness==='READY'?'PRONTO':summary.readiness==='READY_WITH_WARNINGS'?'PRONTO COM ALERTAS':'NÃO PRONTO'
  const lines=[`Briefing D-1 — ${summary.event.eventName}`,`${icon} Readiness: ${label} · Health ${summary.event.healthScore}/100`]
  if(summary.event.venueName)lines.push(`📍 ${summary.event.venueName}${summary.event.venueAddress?` — ${summary.event.venueAddress}`:''}`)
  if(summary.readinessReasons.length){lines.push('','Pontos de atenção:');for(const reason of summary.readinessReasons.slice(0,6))lines.push(`• ${reason}`)}
  lines.push('','Fornecedores:',`• ${summary.counts.confirmedVendors} confirmado(s) · ${summary.counts.pendingVendors} pendente(s) · ${summary.counts.declinedVendors} recusado(s)`)
  if(summary.tasks.length){lines.push('','Checklist final:');for(const task of summary.tasks.slice(0,5))lines.push(`• ${task.overdue?'ATRASADA — ':''}${task.title}`)}
  if(summary.timeline.length){lines.push('','Cronograma operacional:');for(const item of summary.timeline.slice(0,10))lines.push(`• ${formatLocalTime(item.at,summary.timezone)} — ${item.title}`)}
  lines.push('','Se quiser, posso detalhar qualquer alerta, fornecedor ou item do checklist.')
  return lines.join('\n')
}

function localDayRange(referenceDate:string,timeZone:string){const [year,month,day]=referenceDate.split('-').map(Number);return{start:localDateTimeToUtc({year,month,day,hour:0,minute:0,second:0},timeZone),end:localDateTimeToUtc(nextDay(year,month,day),timeZone)}}
function nextDay(year:number,month:number,day:number){const d=new Date(Date.UTC(year,month-1,day+1));return{year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:0,minute:0,second:0}}
function localDate(at:Date,timeZone:string){const p=partsInTimeZone(at,timeZone);return formatDate(p.year,p.month,p.day)}
function formatDate(y:number,m:number,d:number){return`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function addLocalDays(referenceDate:string,days:number){const[y,m,d]=referenceDate.split('-').map(Number);const shifted=new Date(Date.UTC(y,m-1,d+days));return formatDate(shifted.getUTCFullYear(),shifted.getUTCMonth()+1,shifted.getUTCDate())}
function daysBetweenLocal(referenceDate:string,target:Date,timeZone:string){const p=partsInTimeZone(target,timeZone);const targetDate=Date.UTC(p.year,p.month-1,p.day);const [y,m,d]=referenceDate.split('-').map(Number);return Math.round((targetDate-Date.UTC(y,m-1,d))/86400000)}
function formatLocalTime(iso:string,timeZone:string){return new Intl.DateTimeFormat('pt-BR',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso))}
function requiredId(value:string,name:string){if(!value?.trim())throw new BriefValidationError(`${name} is required`);return value.trim()}
function assertReferenceDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new BriefValidationError('referenceDate must use YYYY-MM-DD format')}
function isTime(value:string){return/^([01]\d|2[0-3]):[0-5]\d$/.test(value)}
function normalizeRecipient(value:string|null|undefined):string|null{if(value===null||value===undefined||!value.trim())return null;const digits=value.replace(/\D/g,'');if(digits.length<10||digits.length>15)throw new BriefValidationError('WhatsApp recipient must contain between 10 and 15 digits');return digits}
function clamp(v:number,min:number,max:number){return Number.isInteger(v)?Math.max(min,Math.min(max,v)):min}
