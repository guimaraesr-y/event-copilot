import type {
  EventRisk,
  ListRisksInput,
  OutboxMessage,
  RiskCandidate,
  RiskEvaluation,
  RiskReconciliationResult,
  RiskSeverity,
  RiskSnapshot,
  RiskStore,
  RiskType,
  RiskSourceType,
} from '@ecc/domain'
import { RiskConflictError, RiskNotFoundError, RiskValidationError } from '@ecc/domain'

export interface RiskEngineDependencies {
  store: RiskStore
  now?: () => Date
  newId?: () => string
}

export interface EvaluateRiskInput {
  organizationId: string
  eventId: string
  triggerType: 'domain_event' | 'scheduled' | 'manual'
  triggerKey: string
  at?: Date
}

export interface WorkspaceRiskSummary {
  eventId: string
  eventName: string
  eventStartAt: Date
  maxScore: number
  maxSeverity: RiskSeverity
  activeCount: number
  criticalCount: number
  highCount: number
  risks: EventRisk[]
}

const RELEVANT_DOMAIN_EVENTS = new Set([
  'event.created','event.updated',
  'task.created','task.updated','task.completed',
  'vendor.attached','vendor.assignment_updated','vendor.confirmation_requested','vendor.confirmed','vendor.declined',
  'message.review_required','message.failed',
  'change.applied','change.rejected',
  'dependency.applied','dependency.resolved','dependency.dismissed',
])

export class RiskEngine {
  private readonly now: () => Date
  private readonly newId: () => string
  constructor(private readonly deps: RiskEngineDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async evaluateEvent(input: EvaluateRiskInput): Promise<RiskReconciliationResult> {
    if (!input.organizationId.trim() || !input.eventId.trim()) throw new RiskValidationError('organizationId and eventId are required')
    if (!input.triggerKey.trim()) throw new RiskValidationError('triggerKey is required')
    const at = input.at ?? this.now()
    const snapshot = await this.deps.store.loadSnapshot(input.organizationId, input.eventId)
    if (!snapshot) throw new RiskNotFoundError('Event not found for risk evaluation')
    const evaluation: RiskEvaluation = {
      id:this.newId(), organizationId:input.organizationId, eventId:input.eventId,
      triggerType:input.triggerType, triggerKey:input.triggerKey, evaluatedAt:at,
    }
    return this.deps.store.reconcileEvaluation(evaluation, this.buildCandidates(snapshot, at))
  }

  async evaluateDomainEvent(message: OutboxMessage): Promise<RiskReconciliationResult | null> {
    if (!RELEVANT_DOMAIN_EVENTS.has(message.eventType)) return null
    const eventId = eventIdFromMessage(message)
    if (!eventId) return null
    return this.evaluateEvent({ organizationId:message.organizationId, eventId, triggerType:'domain_event', triggerKey:`domain:${message.id}`, at:this.now() })
  }

  async evaluateScheduled(bucketMs = 300_000, at = this.now()): Promise<{ evaluated:number; failed:Array<{organizationId:string;eventId:string;error:string}> }> {
    if (!Number.isInteger(bucketMs) || bucketMs < 60_000) throw new RiskValidationError('Scheduled risk bucket must be at least 60000ms')
    const bucket = Math.floor(at.getTime() / bucketMs)
    const refs = await this.deps.store.listActiveEventRefs()
    let evaluated = 0
    const failed:Array<{organizationId:string;eventId:string;error:string}> = []
    for (const ref of refs) {
      try {
        await this.evaluateEvent({ ...ref, triggerType:'scheduled', triggerKey:`scheduled:${bucket}`, at })
        evaluated++
      } catch (error) {
        failed.push({ organizationId:ref.organizationId,eventId:ref.eventId,error:error instanceof Error?error.message:String(error) })
      }
    }
    return { evaluated, failed }
  }

  get(organizationId:string,riskId:string):Promise<EventRisk> {
    return this.requireRisk(organizationId,riskId)
  }

  list(input:ListRisksInput):Promise<EventRisk[]> { return this.deps.store.list(input) }

  async workspaceSummary(organizationId:string, limit=20):Promise<WorkspaceRiskSummary[]> {
    const active = await this.deps.store.listActive(organizationId, 500)
    const grouped = new Map<string,EventRisk[]>()
    for (const risk of active) grouped.set(risk.eventId,[...(grouped.get(risk.eventId)??[]),risk])
    const summaries:WorkspaceRiskSummary[]=[]
    for (const [eventId,risks] of grouped) {
      const snapshot=await this.deps.store.loadSnapshot(organizationId,eventId)
      if(!snapshot) continue
      risks.sort((a,b)=>b.score-a.score)
      const max=risks[0]
      if(!max) continue
      summaries.push({eventId,eventName:snapshot.event.name,eventStartAt:snapshot.event.startAt,maxScore:max.score,maxSeverity:max.severity,
        activeCount:risks.length,criticalCount:risks.filter(r=>r.severity==='critical').length,highCount:risks.filter(r=>r.severity==='high').length,risks:risks.slice(0,5)})
    }
    return summaries.sort((a,b)=>b.maxScore-a.maxScore||b.criticalCount-a.criticalCount||a.eventStartAt.getTime()-b.eventStartAt.getTime()).slice(0,Math.max(1,Math.min(limit,50)))
  }

  async acknowledge(input:{organizationId:string;riskId:string;sender:string}):Promise<{risk:EventRisk;duplicate:boolean;reply:string}> {
    const sender=input.sender.trim();if(sender.length<2)throw new RiskValidationError('sender is required')
    const risk=await this.requireRisk(input.organizationId,input.riskId)
    if(risk.status==='resolved')throw new RiskConflictError('Resolved risk cannot be acknowledged')
    const at=this.now()
    const event={id:this.newId(),organizationId:risk.organizationId,eventType:'risk.acknowledged',aggregateType:'event_risk',aggregateId:risk.id,occurredAt:at,
      payload:{riskId:risk.id,eventId:risk.eventId,riskType:risk.type,severity:risk.severity,score:risk.score,title:risk.title,acknowledgedBy:sender}}
    const result=await this.deps.store.acknowledge(risk,sender,event)
    return {risk:result.risk,duplicate:!result.acknowledged,reply:result.acknowledged?`Risco reconhecido: ${risk.title}.`:`Risco já estava reconhecido: ${risk.title}.`}
  }

  buildCandidates(snapshot:RiskSnapshot, at:Date):RiskCandidate[] {
    if(snapshot.event.status==='completed'||snapshot.event.status==='cancelled') return []
    const candidates:RiskCandidate[]=[]
    const add=(input:{riskKey:string;type:RiskType;score:number;sourceType:RiskSourceType;sourceId:string|null;title:string;description:string;metadata?:Record<string,unknown>})=>{
      const score=clampScore(input.score)
      candidates.push({id:stableRiskId(snapshot.event.organizationId,snapshot.event.id,input.riskKey),organizationId:snapshot.event.organizationId,eventId:snapshot.event.id,
        riskKey:input.riskKey,type:input.type,severity:severityForScore(score),score,sourceType:input.sourceType,sourceId:input.sourceId,title:input.title,
        description:input.description,metadata:input.metadata??{}})
    }
    const daysUntilEvent=(snapshot.event.startAt.getTime()-at.getTime())/86_400_000
    const eventBoost=urgencyBoost(daysUntilEvent)

    for(const task of snapshot.tasks.filter(t=>t.status==='pending'||t.status==='in_progress')){
      const priority=priorityBoost(task.priority)
      if(task.dueAt.getTime()<at.getTime()){
        const overdueDays=Math.max(1,Math.ceil((at.getTime()-task.dueAt.getTime())/86_400_000))
        add({riskKey:`task_overdue:${task.id}`,type:'task_overdue',score:45+Math.min(20,overdueDays*4)+priority+eventBoost,sourceType:'task',sourceId:task.id,
          title:`Tarefa atrasada: ${task.title}`,description:`Prazo venceu há ${overdueDays} dia(s) e a tarefa continua ${task.status==='in_progress'?'em andamento':'pendente'}.`,
          metadata:{dueAt:task.dueAt.toISOString(),priority:task.priority,status:task.status,overdueDays}})
      } else {
        const hours=(task.dueAt.getTime()-at.getTime())/3_600_000
        if(hours<=48){
          add({riskKey:`task_due_soon:${task.id}`,type:'task_due_soon',score:20+priority+(hours<=12?15:hours<=24?10:5)+eventBoost,sourceType:'task',sourceId:task.id,
            title:`Prazo próximo: ${task.title}`,description:`A tarefa vence em aproximadamente ${Math.max(1,Math.ceil(hours))} hora(s).`,
            metadata:{dueAt:task.dueAt.toISOString(),priority:task.priority,status:task.status,hoursUntilDue:Math.round(hours)}})
        }
      }
    }

    for(const vendor of snapshot.vendors){
      if(vendor.confirmationStatus==='pending'||vendor.confirmationStatus==='requested'){
        let score=vendorUnconfirmedScore(daysUntilEvent)
        const deadlineOverdue=vendor.confirmationDeadlineAt&&vendor.confirmationDeadlineAt.getTime()<at.getTime()
        if(deadlineOverdue)score+=10
        add({riskKey:`vendor_unconfirmed:${vendor.id}`,type:'vendor_unconfirmed',score,sourceType:'event_vendor',sourceId:vendor.id,
          title:`${vendor.vendorName} ainda não confirmou`,description:deadlineOverdue?'O prazo de confirmação já venceu.':'A participação do fornecedor ainda está pendente.',
          metadata:{vendorName:vendor.vendorName,category:vendor.category,confirmationStatus:vendor.confirmationStatus,confirmationDeadlineAt:vendor.confirmationDeadlineAt?.toISOString()??null,daysUntilEvent:round1(daysUntilEvent)}})
      }
      if(vendor.confirmationStatus==='declined'){
        add({riskKey:`vendor_declined:${vendor.id}`,type:'vendor_declined',score:daysUntilEvent<=7?95:daysUntilEvent<=30?85:70,sourceType:'event_vendor',sourceId:vendor.id,
          title:`${vendor.vendorName} recusou participação`,description:'O evento está sem a cobertura confirmada deste fornecedor.',metadata:{vendorName:vendor.vendorName,category:vendor.category,daysUntilEvent:round1(daysUntilEvent)}})
      }
    }

    const byProposal=new Map<string,typeof snapshot.dependencies>()
    for(const dep of snapshot.dependencies){
      byProposal.set(dep.proposalId,[...(byProposal.get(dep.proposalId)??[]),dep])
      const vendorRelated=dep.dependencyType==='vendor_schedule'||dep.dependencyType==='vendor_reconfirmation'||dep.dependencyType==='venue_logistics_review'
      const base=dep.severity==='critical'?78:dep.severity==='warning'?52:28
      add({riskKey:`${vendorRelated?'vendor_schedule_review':'dependency_unresolved'}:${dep.id}`,type:vendorRelated?'vendor_schedule_review':'dependency_unresolved',
        score:base+eventBoost+(dep.action==='suggest_update'?4:0),sourceType:'dependency_impact',sourceId:dep.id,title:dep.title,
        description:dep.action==='suggest_update'?'Existe um ajuste calculado aguardando aplicação.':'A dependência continua aguardando revisão humana.',
        metadata:{dependencyType:dep.dependencyType,action:dep.action,dependencySeverity:dep.severity,proposalId:dep.proposalId}})
    }
    for(const [proposalId,deps] of byProposal){
      if(deps.length<2)continue
      const critical=deps.filter(d=>d.severity==='critical').length
      const warning=deps.filter(d=>d.severity==='warning').length
      add({riskKey:`change_dependency_pending:${proposalId}`,type:'change_dependency_pending',score:30+Math.min(20,deps.length*4)+(critical?25:warning?12:0)+Math.min(eventBoost,10),sourceType:'change_proposal',sourceId:proposalId,
        title:'Mudança recente deixou dependências pendentes',description:`${deps.length} consequência(s) operacionais da mudança ainda precisam de ajuste ou revisão.`,metadata:{dependencyCount:deps.length,criticalCount:critical,warningCount:warning}})
    }

    for(const item of snapshot.inbox){
      if(item.severity!=='critical'||['dependency_impact','event_risk','event_vendor'].includes(item.sourceType))continue
      add({riskKey:`critical_inbox_item:${item.id}`,type:'critical_inbox_item',score:72+eventBoost,sourceType:'inbox_item',sourceId:item.id,title:item.title,
        description:item.description??'Existe um item crítico no Inbox aguardando ação.',metadata:{inboxType:item.type,inboxStatus:item.status,sourceType:item.sourceType}})
    }

    const recentThreshold=at.getTime()-72*3_600_000
    for(const change of snapshot.appliedChanges){
      if(change.appliedAt.getTime()<recentThreshold||daysUntilEvent>30)continue
      const score=daysUntilEvent<=1?82:daysUntilEvent<=7?65:45
      add({riskKey:`recent_sensitive_change:${change.id}`,type:'recent_sensitive_change',score,sourceType:'change_proposal',sourceId:change.id,
        title:'Mudança sensível aplicada recentemente',description:`Uma alteração de ${changeLabel(change.type)} foi aplicada nas últimas 72 horas perto da data do evento.`,
        metadata:{changeType:change.type,appliedAt:change.appliedAt.toISOString(),currentValue:change.currentValue,proposedValue:change.proposedValue,daysUntilEvent:round1(daysUntilEvent)}})
    }

    return candidates.sort((a,b)=>b.score-a.score||a.riskKey.localeCompare(b.riskKey))
  }

  private async requireRisk(organizationId:string,riskId:string):Promise<EventRisk>{const risk=await this.deps.store.findById(organizationId,riskId);if(!risk)throw new RiskNotFoundError();return risk}
}

export function isRiskRelevantDomainEvent(eventType:string):boolean{return RELEVANT_DOMAIN_EVENTS.has(eventType)}

function eventIdFromMessage(message:OutboxMessage):string|null{
  const value=message.payload.eventId
  if(typeof value==='string'&&value.trim())return value
  return message.aggregateType==='event'?message.aggregateId:null
}
function priorityBoost(priority:string):number{return priority==='critical'?22:priority==='high'?12:priority==='normal'?5:0}
function urgencyBoost(days:number):number{return days<=1?20:days<=3?15:days<=7?10:days<=30?5:0}
function vendorUnconfirmedScore(days:number):number{return days<=1?92:days<=3?84:days<=7?74:days<=14?62:days<=30?47:days<=90?32:18}
function clampScore(value:number):number{return Math.max(0,Math.min(100,Math.round(value)))}
function severityForScore(score:number):RiskSeverity{return score>=75?'critical':score>=50?'high':score>=25?'medium':'low'}
function stableRiskId(organizationId:string,eventId:string,riskKey:string):string{
  const parts=cyrb128(`${organizationId}:${eventId}:${riskKey}`)
  let h=parts.map(n=>n.toString(16).padStart(8,'0')).join('')
  h=`${h.slice(0,12)}5${h.slice(13,16)}${variantHex(h[16]!)}${h.slice(17)}`
  return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`
}
function variantHex(value:string):string{return ((Number.parseInt(value,16)&0x3)|0x8).toString(16)}
function cyrb128(value:string):number[]{let h1=1779033703,h2=3144134277,h3=1013904242,h4=2773480762;for(let i=0;i<value.length;i++){const k=value.charCodeAt(i);h1=h2^Math.imul(h1^k,597399067);h2=h3^Math.imul(h2^k,2869860233);h3=h4^Math.imul(h3^k,951274213);h4=h1^Math.imul(h4^k,2716044179)}h1=Math.imul(h3^(h1>>>18),597399067);h2=Math.imul(h4^(h2>>>22),2869860233);h3=Math.imul(h1^(h3>>>17),951274213);h4=Math.imul(h2^(h4>>>19),2716044179);return[(h1^h2^h3^h4)>>>0,(h2^h1)>>>0,(h3^h1)>>>0,(h4^h1)>>>0]}
function round1(value:number):number{return Math.round(value*10)/10}
function changeLabel(type:string):string{return type==='event_date'?'data':type==='event_time'?'horário':type==='guest_count'?'quantidade de convidados':'local'}
