import type {
  DependencyEntityUpdate,
  DependencyImpact,
  DependencyStore,
  DomainEvent,
  EventMilestone,
  EventTask,
  EventVendor,
  ListDependencyImpactsInput,
  OutboxMessage,
} from '@ecc/domain'
import { DependencyConflictError, DependencyNotFoundError, DependencyValidationError } from '@ecc/domain'
import type { EventEngine } from './event-engine.ts'
import type { VendorEngine } from './vendor-engine.ts'
import { localDateTimeToUtc, partsInTimeZone } from './schedule.ts'

export interface DependencyEngineDependencies {
  store: DependencyStore
  eventEngine: EventEngine
  vendorEngine: VendorEngine
  now?: () => Date
  newId?: () => string
}

export interface DependencyEvaluationResult {
  impacts: DependencyImpact[]
  created: boolean
  sourceChangeEventId: string
}

export interface DependencyMutationResult {
  impact: DependencyImpact
  duplicate: boolean
  reply: string
}

export class DependencyEngine {
  private readonly now: () => Date
  private readonly newId: () => string
  constructor(private readonly deps: DependencyEngineDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async evaluateAppliedChange(message: OutboxMessage, organizationTimezone: string): Promise<DependencyEvaluationResult> {
    if (message.eventType !== 'change.applied') throw new DependencyValidationError('Dependency evaluation requires a change.applied event')
    const eventId = requireUuidLike(message.payload.eventId, 'eventId')
    const proposalId = requireUuidLike(message.payload.proposalId, 'proposalId')
    const changeType = requireChangeType(message.payload.changeType)
    const currentValue = objectValue(message.payload.currentValue)
    const proposedValue = objectValue(message.payload.proposedValue)

    if (await this.deps.store.hasEvaluation(message.organizationId, message.id)) {
      const existing = await this.deps.store.findBySourceChangeEvent(message.organizationId, message.id)
      return { impacts: existing, created: false, sourceChangeEventId: message.id }
    }

    const [tasks, milestones, vendors] = await Promise.all([
      this.deps.eventEngine.listTasks(message.organizationId, eventId),
      this.deps.eventEngine.listMilestones(message.organizationId, eventId),
      this.deps.vendorEngine.listEventVendors(message.organizationId, eventId),
    ])
    const now = this.now()
    const impacts = this.buildImpacts({ message, eventId, proposalId, changeType, currentValue, proposedValue, organizationTimezone, tasks, milestones, vendors, now })
    const domainEvents = [
      ...impacts.map((impact) => dependencyEvent(this.newId(), impact, 'dependency.detected', now)),
      {
        id:this.newId(), organizationId:message.organizationId, eventType:'dependency.evaluation_completed', aggregateType:'change_proposal', aggregateId:proposalId, occurredAt:now,
        payload:{ proposalId, eventId, sourceChangeEventId:message.id, changeType, impactCount:impacts.length, suggestionCount:impacts.filter((i)=>i.action==='suggest_update').length, reviewCount:impacts.filter((i)=>i.action==='review').length },
      } satisfies DomainEvent,
    ]
    const result = await this.deps.store.createEvaluation({ id:this.newId(), organizationId:message.organizationId, eventId, proposalId, sourceChangeEventId:message.id, changeType, impactCount:impacts.length, createdAt:now }, impacts, domainEvents)
    return { impacts: result.impacts, created: result.created, sourceChangeEventId: message.id }
  }

  async get(organizationId: string, impactId: string): Promise<DependencyImpact> {
    const impact = await this.deps.store.findById(organizationId, impactId)
    if (!impact) throw new DependencyNotFoundError()
    return impact
  }

  async list(input: ListDependencyImpactsInput): Promise<DependencyImpact[]> { return this.deps.store.list(input) }

  async applySuggestion(input: { organizationId:string; impactId:string; decidedBySender:string }): Promise<DependencyMutationResult> {
    const sender = input.decidedBySender.trim(); if (sender.length < 2) throw new DependencyValidationError('decidedBySender must contain at least 2 characters')
    const impact = await this.get(input.organizationId, input.impactId)
    if (impact.status === 'applied') return { impact, duplicate:true, reply:dependencyAppliedReply(impact) }
    if (impact.status !== 'open') throw new DependencyConflictError(`Dependency impact is ${impact.status} and cannot be applied`)
    if (impact.action !== 'suggest_update' || !impact.suggestedValue) throw new DependencyValidationError('This dependency requires human review and has no safe automatic suggestion')
    const update = entityUpdateFromImpact(impact)
    const event = dependencyEvent(this.newId(), impact, 'dependency.applied', this.now(), { decidedBySender:sender })
    const result = await this.deps.store.applySuggestion(impact, update, event)
    return { impact:result.impact, duplicate:!result.applied, reply:dependencyAppliedReply(result.impact) }
  }

  async applySuggestionsForProposal(input: { organizationId:string; proposalId:string; decidedBySender:string }): Promise<{ impacts:DependencyImpact[]; applied:number; duplicates:number; failed:Array<{id:string;error:string}>; reply:string }> {
    const sender = input.decidedBySender.trim(); if (sender.length < 2) throw new DependencyValidationError('decidedBySender must contain at least 2 characters')
    const impacts = await this.list({ organizationId:input.organizationId, proposalId:input.proposalId, status:'open', action:'suggest_update', limit:250 })
    let applied=0, duplicates=0; const failed:Array<{id:string;error:string}>=[]; const values:DependencyImpact[]=[]
    for (const impact of impacts) {
      try { const result=await this.applySuggestion({organizationId:input.organizationId,impactId:impact.id,decidedBySender:sender}); values.push(result.impact); result.duplicate?duplicates++:applied++ }
      catch (error) { failed.push({id:impact.id,error:error instanceof Error?error.message:String(error)}) }
    }
    const reply = failed.length ? `${applied} ajuste(s) aplicado(s); ${failed.length} dependência(s) não puderam ser atualizadas porque o estado mudou ou exige revisão.` : `${applied} ajuste(s) de dependência aplicado(s).`
    return { impacts:values, applied, duplicates, failed, reply }
  }

  async resolveReview(input: { organizationId:string; impactId:string; decidedBySender:string }): Promise<DependencyMutationResult> {
    const sender=input.decidedBySender.trim(); if(sender.length<2) throw new DependencyValidationError('decidedBySender must contain at least 2 characters')
    const impact=await this.get(input.organizationId,input.impactId)
    if(impact.status==='resolved') return {impact,duplicate:true,reply:dependencyResolvedReply(impact)}
    if(impact.status!=='open') throw new DependencyConflictError(`Dependency impact is ${impact.status} and cannot be resolved`)
    if(impact.action!=='review') throw new DependencyValidationError('Only review dependencies can be marked resolved without applying a suggestion')
    const event=dependencyEvent(this.newId(),impact,'dependency.resolved',this.now(),{decidedBySender:sender})
    const result=await this.deps.store.resolveReview(impact,event)
    return {impact:result.impact,duplicate:!result.resolved,reply:dependencyResolvedReply(result.impact)}
  }

  async dismiss(input: { organizationId:string; impactId:string; decidedBySender:string }): Promise<DependencyMutationResult> {
    const sender=input.decidedBySender.trim(); if(sender.length<2) throw new DependencyValidationError('decidedBySender must contain at least 2 characters')
    const impact=await this.get(input.organizationId,input.impactId)
    if(impact.status==='dismissed') return {impact,duplicate:true,reply:`Dependência descartada: ${impact.title}.`}
    if(impact.status!=='open') throw new DependencyConflictError(`Dependency impact is ${impact.status} and cannot be dismissed`)
    const event=dependencyEvent(this.newId(),impact,'dependency.dismissed',this.now(),{decidedBySender:sender})
    const result=await this.deps.store.dismiss(impact,event)
    return {impact:result.impact,duplicate:!result.dismissed,reply:`Dependência descartada: ${result.impact.title}.`}
  }

  private buildImpacts(ctx: BuildContext): DependencyImpact[] {
    const impacts:DependencyImpact[]=[]
    const add=(draft:Omit<DependencyImpact,'id'|'organizationId'|'eventId'|'proposalId'|'sourceChangeEventId'|'createdAt'|'updatedAt'|'resolvedAt'|'status'>)=>impacts.push({
      id:this.newId(),organizationId:ctx.message.organizationId,eventId:ctx.eventId,proposalId:ctx.proposalId,sourceChangeEventId:ctx.message.id,
      status:'open',createdAt:ctx.now,updatedAt:ctx.now,resolvedAt:null,...draft,
    })

    if(ctx.changeType==='event_date') {
      const days=dateDelta(String(ctx.currentValue.date),String(ctx.proposedValue.date))
      for(const task of ctx.tasks.filter(t=>(t.status==='pending'||t.status==='in_progress')&&t.source==='template')) add({ ruleKey:'event_date.template_task.shift', dependencyType:'task_due_date', entityType:'task', entityId:task.id, action:'suggest_update', severity:task.priority==='critical'?'critical':'warning', title:`Recalcular tarefa: ${task.title}`, description:`Tarefa de template deve acompanhar a mudança de ${signed(days)} dia(s) na data do evento.`, currentValue:{dueAt:task.dueAt.toISOString()}, suggestedValue:{dueAt:shiftCalendarDays(task.dueAt,days,ctx.organizationTimezone).toISOString()}, metadata:{days,source:task.source,priority:task.priority} })
      for(const milestone of ctx.milestones.filter(m=>m.status==='pending'&&m.source==='template')) add({ ruleKey:'event_date.template_milestone.shift', dependencyType:'milestone_due_date', entityType:'milestone', entityId:milestone.id, action:'suggest_update', severity:'warning', title:`Recalcular marco: ${milestone.name}`, description:`Marco de template deve acompanhar a mudança de ${signed(days)} dia(s) na data do evento.`, currentValue:{dueAt:milestone.dueAt.toISOString()}, suggestedValue:{dueAt:shiftCalendarDays(milestone.dueAt,days,ctx.organizationTimezone).toISOString()}, metadata:{days,source:milestone.source} })
      const manualOpen=ctx.tasks.filter(t=>(t.status==='pending'||t.status==='in_progress')&&t.source!=='template')
      if(manualOpen.length) add({ ruleKey:'event_date.manual_schedule.review', dependencyType:'manual_schedule_review', entityType:'event', entityId:ctx.eventId, action:'review', severity:'warning', title:'Revisar tarefas não vinculadas ao template', description:`${manualOpen.length} tarefa(s) aberta(s) foram criadas manualmente/por automação e não serão movidas automaticamente.`, currentValue:{count:manualOpen.length}, suggestedValue:null, metadata:{taskIds:manualOpen.slice(0,50).map(t=>t.id)} })
      for(const vendor of ctx.vendors.filter(v=>v.confirmationStatus==='confirmed')) {
        if(vendor.arrivalAt||vendor.departureAt) add({ ruleKey:'event_date.vendor_schedule.shift', dependencyType:'vendor_schedule', entityType:'event_vendor', entityId:vendor.id, action:'suggest_update', severity:'warning', title:`Ajustar agenda de ${vendor.vendorName}`, description:'Chegada/saída cadastradas podem acompanhar a mudança de data do evento.', currentValue:{arrivalAt:iso(vendor.arrivalAt),departureAt:iso(vendor.departureAt)}, suggestedValue:{arrivalAt:isoShiftDays(vendor.arrivalAt,days,ctx.organizationTimezone),departureAt:isoShiftDays(vendor.departureAt,days,ctx.organizationTimezone)}, metadata:{days,vendorName:vendor.vendorName,category:vendor.category} })
        add({ ruleKey:'event_date.vendor_reconfirmation.review', dependencyType:'vendor_reconfirmation', entityType:'event_vendor', entityId:vendor.id, action:'review', severity:'critical', title:`Reconfirmar ${vendor.vendorName}`, description:'Fornecedor estava confirmado para a data anterior; disponibilidade para a nova data precisa ser validada.', currentValue:{confirmationStatus:vendor.confirmationStatus}, suggestedValue:null, metadata:{vendorName:vendor.vendorName,category:vendor.category} })
      }
    } else if(ctx.changeType==='event_time') {
      const minutes=timeDelta(String(ctx.currentValue.time),String(ctx.proposedValue.time))
      for(const vendor of ctx.vendors.filter(v=>v.confirmationStatus==='confirmed'&&(v.arrivalAt||v.departureAt))) add({ ruleKey:'event_time.vendor_schedule.shift', dependencyType:'vendor_schedule', entityType:'event_vendor', entityId:vendor.id, action:'suggest_update', severity:'warning', title:`Ajustar horário de ${vendor.vendorName}`, description:`Agenda operacional pode acompanhar a mudança de ${signed(minutes)} minuto(s) no início do evento.`, currentValue:{arrivalAt:iso(vendor.arrivalAt),departureAt:iso(vendor.departureAt)}, suggestedValue:{arrivalAt:isoShiftMs(vendor.arrivalAt,minutes*60000),departureAt:isoShiftMs(vendor.departureAt,minutes*60000)}, metadata:{minutes,vendorName:vendor.vendorName,category:vendor.category} })
    } else if(ctx.changeType==='guest_count') {
      const before=Number(ctx.currentValue.guestCount), after=Number(ctx.proposedValue.guestCount); const pct=before>0?Math.abs(after-before)/before:1
      const severity=pct>=.25?'critical':'warning'
      const relevant=new Set(['buffet','venue','cake','sweets','security'])
      for(const vendor of ctx.vendors.filter(v=>relevant.has(v.category))) add({ ruleKey:'guest_count.vendor_capacity.review', dependencyType:'guest_capacity_review', entityType:'event_vendor', entityId:vendor.id, action:'review', severity, title:`Revisar capacidade/contrato de ${vendor.vendorName}`, description:`Quantidade mudou de ${before} para ${after}; capacidade, equipe, quantidade ou contrato podem precisar de ajuste.`, currentValue:{guestCount:before}, suggestedValue:null, metadata:{guestCount:after,percentChange:Math.round(pct*100),vendorName:vendor.vendorName,category:vendor.category} })
      if(!ctx.vendors.some(v=>v.category==='venue')) add({ ruleKey:'guest_count.venue_capacity.review', dependencyType:'guest_capacity_review', entityType:'event', entityId:ctx.eventId, action:'review', severity, title:'Revisar capacidade do local', description:`O total de convidados mudou de ${before} para ${after}; confirme se o local comporta a nova quantidade.`, currentValue:{guestCount:before}, suggestedValue:null, metadata:{guestCount:after,percentChange:Math.round(pct*100)} })
    } else if(ctx.changeType==='venue') {
      const confirmed=ctx.vendors.filter(v=>v.confirmationStatus==='confirmed')
      if(!confirmed.length) add({ ruleKey:'venue.event_logistics.review', dependencyType:'venue_logistics_review', entityType:'event', entityId:ctx.eventId, action:'review', severity:'warning', title:'Revisar logística do novo local', description:'Valide acesso, montagem, estacionamento, energia e deslocamentos no novo local.', currentValue:ctx.currentValue, suggestedValue:null, metadata:{proposedVenue:ctx.proposedValue} })
      for(const vendor of confirmed) add({ ruleKey:'venue.vendor_logistics.review', dependencyType:'venue_logistics_review', entityType:'event_vendor', entityId:vendor.id, action:'review', severity:'warning', title:`Revalidar logística com ${vendor.vendorName}`, description:'A troca de local pode alterar acesso, montagem, deslocamento e horários do fornecedor.', currentValue:ctx.currentValue, suggestedValue:null, metadata:{proposedVenue:ctx.proposedValue,vendorName:vendor.vendorName,category:vendor.category} })
    }
    return impacts
  }
}

type BuildContext={ message:OutboxMessage; eventId:string; proposalId:string; changeType:'event_date'|'event_time'|'guest_count'|'venue'; currentValue:Record<string,unknown>; proposedValue:Record<string,unknown>; organizationTimezone:string; tasks:EventTask[]; milestones:EventMilestone[]; vendors:EventVendor[]; now:Date }
function entityUpdateFromImpact(i:DependencyImpact):DependencyEntityUpdate { const s=i.suggestedValue!; if(i.entityType==='task') return {entityType:'task',entityId:i.entityId,dueAt:requiredDate(s.dueAt)}; if(i.entityType==='milestone') return {entityType:'milestone',entityId:i.entityId,dueAt:requiredDate(s.dueAt)}; if(i.entityType==='event_vendor') return {entityType:'event_vendor',entityId:i.entityId,arrivalAt:nullableDate(s.arrivalAt),departureAt:nullableDate(s.departureAt)}; throw new DependencyValidationError('Event-level dependency has no automatic entity update') }
function dependencyEvent(id:string,i:DependencyImpact,eventType:string,at:Date,extra:Record<string,unknown>={}):DomainEvent { return {id,organizationId:i.organizationId,eventType,aggregateType:'dependency_impact',aggregateId:i.id,occurredAt:at,payload:{dependencyImpactId:i.id,proposalId:i.proposalId,eventId:i.eventId,dependencyType:i.dependencyType,entityType:i.entityType,entityId:i.entityId,action:i.action,severity:i.severity,title:i.title,currentValue:i.currentValue,suggestedValue:i.suggestedValue,...extra}} }
function dependencyAppliedReply(i:DependencyImpact):string{return `Ajuste aplicado: ${i.title}.`}
function dependencyResolvedReply(i:DependencyImpact):string{return `Revisão concluída: ${i.title}.`}
function objectValue(v:unknown):Record<string,unknown>{return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>: {}}
function requireUuidLike(v:unknown,f:string):string{if(typeof v!=='string'||!v.trim())throw new DependencyValidationError(`${f} is required`);return v.trim()}
function requireChangeType(v:unknown):BuildContext['changeType']{if(v==='event_date'||v==='event_time'||v==='guest_count'||v==='venue')return v;throw new DependencyValidationError('Unsupported applied change type')}
function dateDelta(a:string,b:string):number{const pa=parseYmd(a),pb=parseYmd(b);return Math.round((Date.UTC(pb[0],pb[1]-1,pb[2])-Date.UTC(pa[0],pa[1]-1,pa[2]))/86400000)}
function parseYmd(v:string):[number,number,number]{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v);if(!m)throw new DependencyValidationError('Invalid change date');return[Number(m[1]),Number(m[2]),Number(m[3])]}
function timeDelta(a:string,b:string):number{const pa=parseHm(a),pb=parseHm(b);return pb[0]*60+pb[1]-(pa[0]*60+pa[1])}
function parseHm(v:string):[number,number]{const m=/^(\d{2}):(\d{2})$/.exec(v);if(!m)throw new DependencyValidationError('Invalid change time');return[Number(m[1]),Number(m[2])]}
function shiftCalendarDays(value:Date,days:number,tz:string):Date{const p=partsInTimeZone(value,tz);const base=new Date(Date.UTC(p.year,p.month-1,p.day+days,p.hour,p.minute,p.second));return localDateTimeToUtc({year:base.getUTCFullYear(),month:base.getUTCMonth()+1,day:base.getUTCDate(),hour:p.hour,minute:p.minute,second:p.second},tz)}
function iso(v:Date|null):string|null{return v?.toISOString()??null}
function isoShiftDays(v:Date|null,d:number,tz:string):string|null{return v?shiftCalendarDays(v,d,tz).toISOString():null}
function isoShiftMs(v:Date|null,ms:number):string|null{return v?new Date(v.getTime()+ms).toISOString():null}
function requiredDate(v:unknown):Date{if(typeof v!=='string'||Number.isNaN(new Date(v).getTime()))throw new DependencyValidationError('Persisted dependency suggestion has invalid date');return new Date(v)}
function nullableDate(v:unknown):Date|null{if(v===null||v===undefined)return null;return requiredDate(v)}
function signed(n:number):string{return n>=0?`+${n}`:String(n)}
