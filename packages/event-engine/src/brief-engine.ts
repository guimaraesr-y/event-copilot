import type {
  BriefEventSummary,
  BriefPreference,
  BriefPriorityItem,
  BriefSnapshotTask,
  BriefStore,
  DailyBrief,
  DailyBriefSnapshot,
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

export class BriefEngine {
  private readonly now:()=>Date
  private readonly newId:()=>string
  constructor(private readonly deps:BriefEngineDependencies){this.now=deps.now??(()=>new Date());this.newId=deps.newId??(()=>crypto.randomUUID())}

  async getPreference(organizationId:string):Promise<BriefPreference>{return this.deps.store.getPreference(requiredId(organizationId,'organizationId'))}

  async configurePreference(input:{organizationId:string;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;fallbackRecipient?:string|null}):Promise<BriefPreference>{
    const organizationId=requiredId(input.organizationId,'organizationId')
    if(input.localTime!==undefined&&!isTime(input.localTime))throw new BriefValidationError('localTime must use HH:mm format')
    const current=await this.deps.store.getPreference(organizationId)
    let recipient=input.recipient!==undefined?normalizeRecipient(input.recipient):current.recipient
    const enabled=input.enabled??current.enabled
    if(enabled&&!recipient&&input.fallbackRecipient)recipient=normalizeRecipient(input.fallbackRecipient)
    if(enabled&&!recipient)throw new BriefValidationError('A WhatsApp recipient is required before enabling the daily brief')
    return this.deps.store.updatePreference({organizationId,enabled,localTime:input.localTime,recipient,updatedBySender:input.updatedBySender,at:this.now()})
  }

  async generateDaily(input:GenerateDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>{
    const organizationId=requiredId(input.organizationId,'organizationId')
    if(!input.triggerKey.trim())throw new BriefValidationError('triggerKey is required')
    const at=input.at??this.now()
    const snapshot=await this.deps.store.loadDailySnapshot(organizationId)
    if(!snapshot)throw new BriefNotFoundError('Organization not found for daily brief')
    const referenceDate=input.referenceDate??localDate(at,snapshot.timezone)
    if(!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate))throw new BriefValidationError('referenceDate must use YYYY-MM-DD format')
    const summary=buildSummary(snapshot,referenceDate)
    const renderedText=renderDailyBrief(snapshot.organizationName,summary)
    const requestDelivery=input.requestDelivery??false
    let recipient=input.recipient!==undefined?normalizeRecipient(input.recipient):null
    if(requestDelivery&&!recipient){const pref=await this.deps.store.getPreference(organizationId);recipient=pref.recipient}
    if(requestDelivery&&!recipient)throw new BriefValidationError('Daily brief delivery requires a WhatsApp recipient')
    const id=this.newId()
    const domainEvent=requestDelivery?{
      id:this.newId(),organizationId,eventType:'brief.delivery_requested',aggregateType:'daily_brief',aggregateId:id,occurredAt:at,
      payload:{briefId:id,referenceDate,recipient,text:renderedText,channel:'whatsapp',messageType:'daily_brief',source:'operational_agent'},
    }:null
    return this.deps.store.persistDaily({
      brief:{id,organizationId,type:'daily',referenceDate,triggerType:input.triggerType,triggerKey:input.triggerKey,summary,renderedText,generatedBySender:input.generatedBySender??null,generatedAt:at,deliveryRequestedAt:requestDelivery?at:null},
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
  async get(organizationId:string,briefId:string):Promise<DailyBrief>{const value=await this.deps.store.getById(requiredId(organizationId,'organizationId'),requiredId(briefId,'briefId'));if(!value)throw new BriefNotFoundError();return value}
  list(organizationId:string,limit=30):Promise<DailyBrief[]>{return this.deps.store.listDaily(requiredId(organizationId,'organizationId'),clamp(limit,1,100))}

  async processDueSchedules(at=this.now()):Promise<{generated:number;duplicates:number;failed:Array<{organizationId:string;error:string}>}>{
    const preferences=await this.deps.store.listScheduledPreferences()
    let generated=0,duplicates=0
    const failed:Array<{organizationId:string;error:string}>=[]
    for(const pref of preferences){
      try{
        const parts=partsInTimeZone(at,pref.timezone)
        const currentMinutes=parts.hour*60+parts.minute
        const [hour,minute]=pref.localTime.split(':').map(Number)
        if(currentMinutes<hour*60+minute)continue
        const referenceDate=formatDate(parts.year,parts.month,parts.day)
        const result=await this.generateDaily({organizationId:pref.organizationId,triggerType:'scheduled',triggerKey:`scheduled:${referenceDate}`,referenceDate,requestDelivery:true,recipient:pref.recipient,generatedBySender:'operational_agent',at})
        if(result.duplicate)duplicates++;else generated++
      }catch(error){failed.push({organizationId:pref.organizationId,error:error instanceof Error?error.message:String(error)})}
    }
    return{generated,duplicates,failed}
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

export function renderDailyBrief(organizationName:string,summary:ReturnType<typeof buildSummary>):string{
  const lines=[`Bom dia! Brief operacional de ${summary.referenceDate}.`,'']
  if(summary.activeEvents===0)return`${lines[0]}\n\nNenhum evento ativo no momento.`
  lines.push(`${summary.activeEvents} evento(s) ativo(s) · ${summary.overdueTasks} tarefa(s) atrasada(s) · ${summary.pendingVendors} fornecedor(es) pendente(s).`,'')
  for(const event of summary.events.slice(0,5)){
    const icon=event.healthStatus==='critical'?'🔴':event.healthStatus==='attention'?'🟠':event.healthStatus==='good'?'🟢':'🟢'
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

function localDayRange(referenceDate:string,timeZone:string){const [year,month,day]=referenceDate.split('-').map(Number);return{start:localDateTimeToUtc({year,month,day,hour:0,minute:0,second:0},timeZone),end:localDateTimeToUtc(nextDay(year,month,day),timeZone)}}
function nextDay(year:number,month:number,day:number){const d=new Date(Date.UTC(year,month-1,day+1));return{year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:0,minute:0,second:0}}
function localDate(at:Date,timeZone:string){const p=partsInTimeZone(at,timeZone);return formatDate(p.year,p.month,p.day)}
function formatDate(y:number,m:number,d:number){return`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function daysBetweenLocal(referenceDate:string,target:Date,timeZone:string){const p=partsInTimeZone(target,timeZone);const targetDate=Date.UTC(p.year,p.month-1,p.day);const [y,m,d]=referenceDate.split('-').map(Number);return Math.round((targetDate-Date.UTC(y,m-1,d))/86400000)}
function requiredId(value:string,name:string){if(!value?.trim())throw new BriefValidationError(`${name} is required`);return value.trim()}
function isTime(value:string){return/^([01]\d|2[0-3]):[0-5]\d$/.test(value)}
function normalizeRecipient(value:string|null|undefined):string|null{if(value===null||value===undefined||!value.trim())return null;const digits=value.replace(/\D/g,'');if(digits.length<10||digits.length>15)throw new BriefValidationError('WhatsApp recipient must contain between 10 and 15 digits');return digits}
function clamp(v:number,min:number,max:number){return Number.isInteger(v)?Math.max(min,Math.min(max,v)):min}
