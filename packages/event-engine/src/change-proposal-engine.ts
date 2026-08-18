import type {
  ChangeProposal,
  ChangeProposalImpact,
  ChangeProposalStore,
  ChangeProposalType,
  ChangeProposalWithImpacts,
  CreateChangeProposalInput,
  DomainEvent,
  Event,
  ListChangeProposalsInput,
} from '@ecc/domain'
import {
  ChangeProposalConflictError,
  ChangeProposalNotFoundError,
  ChangeProposalValidationError,
} from '@ecc/domain'
import type { EventEngine } from './event-engine.ts'
import type { VendorEngine } from './vendor-engine.ts'
import { assertTimeZone, localDateTimeToUtc, partsInTimeZone } from './schedule.ts'

export interface ChangeProposalEngineDependencies {
  store: ChangeProposalStore
  eventEngine: EventEngine
  vendorEngine: VendorEngine
  now?: () => Date
  newId?: () => string
}

export interface ChangeProposalMutationResult extends ChangeProposalWithImpacts {
  duplicate: boolean
  reply: string
}

export class ChangeProposalEngine {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: ChangeProposalEngineDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async create(input: CreateChangeProposalInput): Promise<ChangeProposalMutationResult> {
    const sender = input.requestedBySender.trim()
    const key = input.idempotencyKey.trim()
    if (sender.length < 2) throw new ChangeProposalValidationError('requestedBySender must contain at least 2 characters')
    if (key.length < 4) throw new ChangeProposalValidationError('idempotencyKey must contain at least 4 characters')
    assertTimeZone(input.organizationTimezone)

    const existing = await this.deps.store.findByIdempotencyKey(input.organizationId, key)

    const event = await this.deps.eventEngine.getEvent(input.organizationId, input.eventId)
    if (!event) throw new ChangeProposalValidationError('Event not found')

    const proposedValue = normalizeProposedValue(input.type, input.proposedValue, event)
    if (existing) {
      if (!sameProposalRequest(existing.proposal, input, proposedValue)) throw new ChangeProposalConflictError('idempotencyKey was already used for a different change proposal payload')
      return { ...existing, duplicate: true, reply: proposalReply(existing) }
    }
    const currentValue = currentValueFor(event, input.type, input.organizationTimezone)
    assertDifferent(currentValue, proposedValue)

    const now = this.now()
    const proposal: ChangeProposal = {
      id: this.newId(),
      organizationId: input.organizationId,
      eventId: event.id,
      requestedBySender: sender,
      decidedBySender: null,
      sourceAgentTurnId: input.sourceAgentTurnId ?? null,
      idempotencyKey: key,
      type: input.type,
      currentValue,
      proposedValue,
      reason: input.reason?.trim() || null,
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      appliedAt: null,
    }

    const impacts = await this.buildImpacts(proposal, event)
    const domainEvent = changeEvent(this.newId(), proposal, 'change.proposed', now, {
      currentValue, proposedValue, impacts: impacts.map(serializeImpactForEvent), reason: proposal.reason,
    })
    const result = await this.deps.store.createWithOutbox(proposal, impacts, domainEvent)
    if (!result.created && !sameProposalRequest(result.value.proposal, input, proposedValue)) throw new ChangeProposalConflictError('idempotencyKey was concurrently used for a different change proposal payload')
    return { ...result.value, duplicate: !result.created, reply: proposalReply(result.value) }
  }

  async get(organizationId: string, proposalId: string): Promise<ChangeProposalWithImpacts> {
    const value = await this.deps.store.findById(organizationId, proposalId)
    if (!value) throw new ChangeProposalNotFoundError()
    return value
  }

  async list(input: ListChangeProposalsInput): Promise<ChangeProposalWithImpacts[]> {
    return this.deps.store.list(input)
  }

  async approve(input: { organizationId: string; organizationTimezone: string; proposalId: string; decidedBySender: string }): Promise<ChangeProposalMutationResult> {
    const sender = input.decidedBySender.trim()
    if (sender.length < 2) throw new ChangeProposalValidationError('decidedBySender must contain at least 2 characters')
    assertTimeZone(input.organizationTimezone)
    const value = await this.get(input.organizationId, input.proposalId)
    if (value.proposal.status === 'applied') return { ...value, duplicate: true, reply: appliedReply(value) }
    if (value.proposal.status !== 'proposed') throw new ChangeProposalConflictError(`Proposal is ${value.proposal.status} and cannot be approved`)

    const event = await this.deps.eventEngine.getEvent(input.organizationId, value.proposal.eventId)
    if (!event) throw new ChangeProposalValidationError('Event not found')
    const now = this.now()
    const updatedEvent = applyProposal(event, value.proposal, input.organizationTimezone, now)
    const applied: ChangeProposal = {
      ...value.proposal,
      status: 'applied', decidedBySender: sender, decidedAt: now, appliedAt: now, updatedAt: now,
    }
    const events: DomainEvent[] = [
      changeEvent(this.newId(), applied, 'change.applied', now, {
        currentValue: applied.currentValue, proposedValue: applied.proposedValue, decidedBySender: sender,
      }),
      {
        id: this.newId(), organizationId: applied.organizationId, eventType: 'event.updated', aggregateType: 'event', aggregateId: event.id,
        occurredAt: now,
        payload: {
          eventId: event.id, proposalId: applied.id, changeType: applied.type,
          before: applied.currentValue, after: applied.proposedValue,
        },
      },
    ]
    const result = await this.deps.store.applyWithOutbox(applied, updatedEvent, events)
    return { ...result.value, duplicate: !result.applied, reply: appliedReply(result.value) }
  }

  async reject(input: { organizationId: string; proposalId: string; decidedBySender: string; reason?: string | null }): Promise<ChangeProposalMutationResult> {
    const sender = input.decidedBySender.trim()
    if (sender.length < 2) throw new ChangeProposalValidationError('decidedBySender must contain at least 2 characters')
    const value = await this.get(input.organizationId, input.proposalId)
    if (value.proposal.status === 'rejected') return { ...value, duplicate: true, reply: rejectedReply(value) }
    if (value.proposal.status !== 'proposed') throw new ChangeProposalConflictError(`Proposal is ${value.proposal.status} and cannot be rejected`)
    const now = this.now()
    const rejected: ChangeProposal = {
      ...value.proposal,
      status: 'rejected', decidedBySender: sender, decidedAt: now, updatedAt: now,
      reason: input.reason?.trim() || value.proposal.reason,
    }
    const event = changeEvent(this.newId(), rejected, 'change.rejected', now, {
      currentValue: rejected.currentValue, proposedValue: rejected.proposedValue, decidedBySender: sender, reason: rejected.reason,
    })
    const result = await this.deps.store.rejectWithOutbox(rejected, event)
    return { ...result.value, duplicate: !result.rejected, reply: rejectedReply(result.value) }
  }

  private async buildImpacts(proposal: ChangeProposal, event: Event): Promise<ChangeProposalImpact[]> {
    const [tasks, milestones, vendors] = await Promise.all([
      this.deps.eventEngine.listTasks(proposal.organizationId, event.id),
      this.deps.eventEngine.listMilestones(proposal.organizationId, event.id),
      this.deps.vendorEngine.listEventVendors(proposal.organizationId, event.id),
    ])
    const openTasks = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress')
    const pendingMilestones = milestones.filter((item) => item.status === 'pending')
    const confirmedVendors = vendors.filter((vendor) => vendor.confirmationStatus === 'confirmed')
    const impacts: ChangeProposalImpact[] = []
    const add = (category: ChangeProposalImpact['category'], severity: ChangeProposalImpact['severity'], title: string, description: string, metadata: Record<string, unknown> = {}) => {
      impacts.push({ id: this.newId(), organizationId: proposal.organizationId, proposalId: proposal.id, eventId: event.id, category, severity, title, description, metadata, createdAt: proposal.createdAt })
    }

    if (proposal.type === 'event_date') {
      add('schedule', openTasks.length || pendingMilestones.length ? 'warning' : 'info', 'Cronograma precisa ser revisado', `${openTasks.length} tarefa(s) aberta(s) e ${pendingMilestones.length} marco(s) permanecem com as datas atuais nesta versão.`, { openTasks: openTasks.length, pendingMilestones: pendingMilestones.length })
      if (confirmedVendors.length) add('vendor', 'critical', 'Fornecedores confirmados precisam ser reconfirmados', `${confirmedVendors.length} fornecedor(es) já confirmado(s) podem ter disponibilidade afetada pela nova data.`, { confirmedVendors: confirmedVendors.length })
    } else if (proposal.type === 'event_time') {
      const scheduled = confirmedVendors.filter((vendor) => vendor.arrivalAt || vendor.departureAt)
      add('schedule', 'warning', 'Horários operacionais podem mudar', 'O horário principal do evento será alterado, mas horários de fornecedores não são deslocados automaticamente.', { scheduledVendors: scheduled.length })
      if (confirmedVendors.length) add('vendor', confirmedVendors.length >= 3 ? 'critical' : 'warning', 'Revalidar horário com fornecedores confirmados', `${confirmedVendors.length} fornecedor(es) confirmado(s) podem precisar ajustar chegada, montagem ou saída.`, { confirmedVendors: confirmedVendors.length })
    } else if (proposal.type === 'guest_count') {
      const before = Number(proposal.currentValue.guestCount)
      const after = Number(proposal.proposedValue.guestCount)
      const delta = after - before
      const pct = before > 0 ? Math.abs(delta) / before : 1
      const affected = vendors.filter((vendor) => ['buffet','venue','cake','sweets','security'].includes(vendor.category))
      add('guest', pct >= 0.25 ? 'critical' : 'warning', 'Quantidade de convidados impacta capacidade e contratos', `A proposta altera o total de ${before} para ${after} convidado(s) (${delta >= 0 ? '+' : ''}${delta}).`, { before, after, delta, percentChange: Math.round(pct * 100) })
      if (affected.length) add('vendor', 'warning', 'Fornecedores dependentes de quantidade devem ser revisados', `${affected.length} fornecedor(es) de buffet/local/bolo/doces/segurança podem precisar de ajuste comercial ou operacional.`, { affectedVendors: affected.length })
    } else if (proposal.type === 'venue') {
      add('logistics', confirmedVendors.length ? 'critical' : 'warning', 'Logística do evento precisa ser revalidada', `A troca de local pode afetar deslocamento, montagem, acesso e horários de ${vendors.length} fornecedor(es).`, { vendors: vendors.length, confirmedVendors: confirmedVendors.length })
    }

    if (!impacts.length) add('schedule', 'info', 'Alteração isolada', 'Nenhuma dependência adicional foi detectada pelas regras atuais.')
    return impacts
  }
}

function normalizeProposedValue(type: ChangeProposalType, value: Record<string, unknown>, event: Event): Record<string, unknown> {
  if (type === 'event_date') {
    const date = requiredText(value.date, 'date')
    if (!isValidYmd(date)) throw new ChangeProposalValidationError('event_date proposedValue.date must be a valid YYYY-MM-DD date')
    return { date }
  }
  if (type === 'event_time') {
    const time = requiredText(value.time, 'time')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ChangeProposalValidationError('event_time proposedValue.time must use HH:mm')
    return { time }
  }
  if (type === 'guest_count') {
    const guestCount = value.guestCount
    if (!Number.isInteger(guestCount) || (guestCount as number) < 0 || (guestCount as number) > 100000) throw new ChangeProposalValidationError('guest_count proposedValue.guestCount must be an integer between 0 and 100000')
    return { guestCount }
  }
  const venueName = Object.prototype.hasOwnProperty.call(value, 'venueName') ? nullableText(value.venueName) : event.venueName
  const venueAddress = Object.prototype.hasOwnProperty.call(value, 'venueAddress') ? nullableText(value.venueAddress) : event.venueAddress
  if (!venueName && !venueAddress) throw new ChangeProposalValidationError('venue proposal requires venueName or venueAddress')
  return { venueName, venueAddress }
}

function currentValueFor(event: Event, type: ChangeProposalType, timezone: string): Record<string, unknown> {
  const local = partsInTimeZone(event.startAt, timezone)
  if (type === 'event_date') return { date: `${local.year}-${pad(local.month)}-${pad(local.day)}` }
  if (type === 'event_time') return { time: `${pad(local.hour)}:${pad(local.minute)}` }
  if (type === 'guest_count') return { guestCount: event.guestCount }
  return { venueName: event.venueName, venueAddress: event.venueAddress }
}

function applyProposal(event: Event, proposal: ChangeProposal, timezone: string, now: Date): Event {
  let startAt = event.startAt
  let endAt = event.endAt
  let guestCount = event.guestCount
  let venueName = event.venueName
  let venueAddress = event.venueAddress
  if (proposal.type === 'event_date' || proposal.type === 'event_time') {
    const local = partsInTimeZone(event.startAt, timezone)
    if (proposal.type === 'event_date') {
      const [year, month, day] = String(proposal.proposedValue.date).split('-').map(Number)
      startAt = localDateTimeToUtc({ ...local, year: year!, month: month!, day: day! }, timezone)
    } else {
      const [hour, minute] = String(proposal.proposedValue.time).split(':').map(Number)
      startAt = localDateTimeToUtc({ ...local, hour: hour!, minute: minute!, second: 0 }, timezone)
    }
    if (event.endAt) endAt = new Date(startAt.getTime() + (event.endAt.getTime() - event.startAt.getTime()))
  } else if (proposal.type === 'guest_count') {
    guestCount = Number(proposal.proposedValue.guestCount)
  } else {
    venueName = nullableText(proposal.proposedValue.venueName)
    venueAddress = nullableText(proposal.proposedValue.venueAddress)
  }
  return { ...event, startAt, endAt, guestCount, venueName, venueAddress, updatedAt: now }
}

function changeEvent(id: string, proposal: ChangeProposal, eventType: string, occurredAt: Date, extra: Record<string, unknown>): DomainEvent {
  return { id, organizationId: proposal.organizationId, eventType, aggregateType: 'change_proposal', aggregateId: proposal.id, occurredAt, payload: { proposalId: proposal.id, eventId: proposal.eventId, changeType: proposal.type, requestedBySender: proposal.requestedBySender, ...extra } }
}
function serializeImpactForEvent(i: ChangeProposalImpact) { return { category: i.category, severity: i.severity, title: i.title, description: i.description, metadata: i.metadata } }
function isValidYmd(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year=Number(match[1]), month=Number(match[2]), day=Number(match[3])
  const d=new Date(Date.UTC(year,month-1,day))
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day
}
function sameProposalRequest(existing: ChangeProposal, input: CreateChangeProposalInput, proposedValue: Record<string, unknown>): boolean {
  return existing.eventId===input.eventId && existing.requestedBySender===input.requestedBySender.trim() && existing.type===input.type && JSON.stringify(existing.proposedValue)===JSON.stringify(proposedValue)
}
function requiredText(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim()) throw new ChangeProposalValidationError(`${field} is required`); return value.trim() }
function nullableText(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function pad(value: number): string { return String(value).padStart(2, '0') }
function assertDifferent(current: Record<string, unknown>, proposed: Record<string, unknown>): void { if (JSON.stringify(current) === JSON.stringify(proposed)) throw new ChangeProposalValidationError('Proposed value is equal to the current value') }
function proposalReply(value: ChangeProposalWithImpacts): string {
  const p = value.proposal
  const change = describeChange(p)
  const impacts = value.impacts.slice(0, 3).map((i) => `${severityLabel(i.severity)} ${i.title}`).join(' ')
  return `Proposta criada para ${change}. ${impacts} Deseja aprovar essa alteração?`.trim()
}
function appliedReply(value: ChangeProposalWithImpacts): string { return `Alteração aprovada e aplicada: ${describeChange(value.proposal)}.` }
function rejectedReply(value: ChangeProposalWithImpacts): string { return `Proposta rejeitada: ${describeChange(value.proposal)}.` }
function describeChange(p: ChangeProposal): string {
  if (p.type === 'event_date') return `mudar a data de ${p.currentValue.date} para ${p.proposedValue.date}`
  if (p.type === 'event_time') return `mudar o horário de ${p.currentValue.time} para ${p.proposedValue.time}`
  if (p.type === 'guest_count') return `mudar os convidados de ${p.currentValue.guestCount} para ${p.proposedValue.guestCount}`
  return `mudar o local para ${p.proposedValue.venueName ?? p.proposedValue.venueAddress}`
}
function severityLabel(value: ChangeProposalImpact['severity']): string { return value === 'critical' ? 'Crítico:' : value === 'warning' ? 'Atenção:' : 'Info:' }
