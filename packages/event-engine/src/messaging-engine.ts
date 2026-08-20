import type {
  AutomationActionRef,
  CanonicalMessagingWebhookEvent,
  DomainEvent,
  InboundMessage,
  MessageStore,
  MessagingProvider,
  OutboundMessage,
  ProviderStatusInput,
} from '@ecc/domain'
import {
  AutomationActionNotFoundError,
  MessageSendInProgressError,
  MessagingProviderError,
  MessagingValidationError,
  OutboundMessageNotFoundError,
} from '@ecc/domain'

const VENDOR_CONFIRMATION_ACTION = 'vendor_confirmation.prepare'
const VENDOR_CONFIRMATION_MESSAGE = 'vendor_confirmation'
const LEGACY_DAILY_BRIEF_ACTION = 'daily_brief.prepare'
const BRIEF_ACTION = 'brief.prepare'
const BRIEF_MESSAGE_TYPES = new Set(['daily_brief','d_minus_1_brief'])

export interface MessagingEngineDependencies {
  store: MessageStore
  provider: MessagingProvider
  now?: () => Date
  newId?: () => string
}

export class MessagingEngine {
  private readonly store: MessageStore
  private readonly provider: MessagingProvider
  private readonly now: () => Date
  private readonly newId: () => string

  constructor({ store, provider, now = () => new Date(), newId = () => crypto.randomUUID() }: MessagingEngineDependencies) {
    this.store = store
    this.provider = provider
    this.now = now
    this.newId = newId
  }

  async prepareVendorConfirmation(actionId: string): Promise<{ message: OutboundMessage; created: boolean }> {
    const action = await this.store.findAutomationAction(actionId)
    if (!action) throw new AutomationActionNotFoundError()
    this.assertVendorConfirmationAction(action)

    const existing = await this.store.findMessageBySourceAction(action.id)
    if (existing) return { message: existing, created: false }

    const phone = requiredString(action.payload.phone, 'Vendor confirmation action is missing a phone number')
    const vendorName = requiredString(action.payload.vendorName, 'Vendor confirmation action is missing vendorName')
    const eventName = requiredString(action.payload.eventName, 'Vendor confirmation action is missing eventName')
    const eventStartAt = requiredString(action.payload.eventStartAt, 'Vendor confirmation action is missing eventStartAt')
    const timezone = await this.store.getOrganizationTimezone(action.organizationId) ?? 'UTC'
    const now = this.now()
    const content = buildVendorConfirmationMessage({ vendorName, eventName, eventStartAt, timezone })

    const message: OutboundMessage = {
      id: this.newId(),
      organizationId: action.organizationId,
      sourceActionId: action.id,
      channel: 'whatsapp',
      provider: this.provider.name,
      recipient: normalizePhone(phone),
      messageType: VENDOR_CONFIRMATION_MESSAGE,
      aggregateType: action.aggregateType,
      aggregateId: action.aggregateId,
      status: 'pending',
      externalMessageId: null,
      payload: {
        text: content,
        vendorName,
        eventName,
        eventStartAt,
        timezone,
        eventId: action.payload.eventId,
        eventVendorId: action.payload.eventVendorId,
        deadlineAt: action.payload.deadlineAt ?? null,
      },
      providerResponse: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      lastError: null,
    }

    return this.store.createMessageWithOutbox(message, this.domainEvent(message, 'message.created', {
      messageId: message.id,
      sourceActionId: action.id,
      channel: message.channel,
      provider: message.provider,
      recipient: message.recipient,
      messageType: message.messageType,
    }))
  }

  async prepareBrief(actionId: string): Promise<{ message: OutboundMessage; created: boolean }> {
    const action = await this.store.findAutomationAction(actionId)
    if (!action) throw new AutomationActionNotFoundError()
    if (action.actionType !== BRIEF_ACTION && action.actionType !== LEGACY_DAILY_BRIEF_ACTION) throw new MessagingValidationError(`Automation action ${action.id} is not a brief preparation action`)
    if (action.status === 'cancelled') throw new MessagingValidationError('Cancelled automation action cannot create an outbound message')
    const existing = await this.store.findMessageBySourceAction(action.id)
    if (existing) return { message: existing, created: false }
    const recipient = normalizePhone(requiredString(action.payload.recipient, 'Brief action is missing recipient'))
    const text = requiredString(action.payload.text, 'Brief action is missing text')
    const briefId = requiredString(action.payload.briefId, 'Brief action is missing briefId')
    const messageType = typeof action.payload.messageType === 'string' && BRIEF_MESSAGE_TYPES.has(action.payload.messageType) ? action.payload.messageType : 'daily_brief'
    const now = this.now()
    const message: OutboundMessage = {
      id: this.newId(), organizationId: action.organizationId, sourceActionId: action.id, channel: 'whatsapp', provider: this.provider.name, recipient,
      messageType, aggregateType: action.aggregateType, aggregateId: action.aggregateId, status: 'pending', externalMessageId: null,
      payload: { text, briefId, briefType: action.payload.briefType ?? (messageType === 'd_minus_1_brief' ? 'd_minus_1' : 'daily'), eventId: action.payload.eventId ?? null, eventName: action.payload.eventName ?? null, referenceDate: action.payload.referenceDate ?? null, source: 'brief_engine' }, providerResponse: null,
      createdAt: now, updatedAt: now, sentAt: null, deliveredAt: null, readAt: null, failedAt: null, lastError: null,
    }
    return this.store.createMessageWithOutbox(message, this.domainEvent(message, 'message.created', { messageId: message.id, sourceActionId: action.id, channel: message.channel, provider: message.provider, recipient: message.recipient, messageType: message.messageType, briefId, briefType: message.payload.briefType, eventId: message.payload.eventId }))
  }

  async prepareDailyBrief(actionId: string): Promise<{ message: OutboundMessage; created: boolean }> {
    return this.prepareBrief(actionId)
  }

  async send(messageId: string): Promise<{ message: OutboundMessage; duplicate: boolean }> {
    const claim = await this.store.claimForSend(messageId, this.now())
    if (!claim) throw new OutboundMessageNotFoundError()
    if (claim.state === 'already_sent') return { message: claim.message, duplicate: true }
    if (claim.state === 'in_progress') throw new MessageSendInProgressError()

    try {
      const result = await this.provider.send(claim.message)
      if (!result.externalMessageId.trim()) throw new MessagingProviderError('Messaging provider returned an empty external message id')
      const now = this.now()
      const sent = await this.store.markSent(
        claim.message.id,
        result.externalMessageId,
        result.providerResponse ?? null,
        now,
        this.domainEvent(claim.message, 'message.sent', {
          messageId: claim.message.id,
          provider: claim.message.provider,
          externalMessageId: result.externalMessageId,
        }, now),
      )
      return { message: sent, duplicate: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const now = this.now()
      await this.store.markFailed(
        claim.message.id,
        message,
        now,
        this.domainEvent(claim.message, 'message.failed', { messageId: claim.message.id, provider: claim.message.provider, error: message, eventId: claim.message.payload.eventId ?? null, eventVendorId: claim.message.payload.eventVendorId ?? null }, now),
      )
      if (error instanceof MessagingProviderError) throw error
      throw new MessagingProviderError(message)
    }
  }

  async applyProviderStatus(input: ProviderStatusInput): Promise<{ message: OutboundMessage; changed: boolean }> {
    if (!input.externalMessageId.trim()) throw new MessagingValidationError('externalMessageId is required')
    if (Number.isNaN(input.occurredAt.getTime())) throw new MessagingValidationError('occurredAt must be a valid date')

    const current = await this.store.findMessageByExternalId(input.provider, input.externalMessageId)
    if (!current) throw new OutboundMessageNotFoundError('No outbound message matches this provider message id')

    const eventType = `message.${input.status}`
    const result = await this.store.applyProviderStatus(input, this.domainEvent(current, eventType, {
      messageId: current.id,
      provider: input.provider,
      externalMessageId: input.externalMessageId,
      status: input.status,
    }, input.occurredAt))
    if (!result) throw new OutboundMessageNotFoundError('No outbound message matches this provider message id')
    return result
  }


  async handleWebhookEvent(input: { event: CanonicalMessagingWebhookEvent; payloadHash: string; rawPayload: Record<string, unknown>; receivedAt?: Date }): Promise<{ duplicate: boolean; handled: boolean; status: string }> {
    const receivedAt = input.receivedAt ?? this.now()
    const registered = await this.store.registerWebhookEvent({ event: input.event, payloadHash: input.payloadHash, rawPayload: input.rawPayload, receivedAt })
    const duplicate = !registered.created

    if (input.event.type === 'message.received') {
      if (duplicate && registered.receipt.status === 'processed') {
        return { duplicate: true, handled: true, status: 'processed' }
      }

      try {
        const candidates = await this.store.findInboundCandidates(input.event.sender, input.event.occurredAt)
        const unique = candidates.length === 1 ? candidates[0] : null
        const now = this.now()
        const inbound: InboundMessage = {
          id: this.newId(),
          organizationId: unique?.organizationId ?? null,
          webhookEventId: registered.receipt.id,
          provider: input.event.provider,
          externalMessageId: input.event.externalMessageId,
          sender: input.event.sender.replace(/\D/g, ''),
          recipient: input.event.recipient,
          content: input.event.content,
          status: unique ? 'resolved' : candidates.length === 0 ? 'ignored' : 'needs_review',
          resolvedEventId: unique?.eventId ?? null,
          resolvedEventVendorId: unique?.eventVendorId ?? null,
          candidateEventVendorIds: candidates.map((candidate) => candidate.eventVendorId),
          interpretation: null,
          receivedAt: input.event.occurredAt,
          processedAt: candidates.length === 1 ? null : now,
          createdAt: now,
          updatedAt: now,
          lastError: candidates.length === 0 ? 'No pending vendor confirmation matches sender' : candidates.length > 1 ? 'Multiple pending vendor confirmations match sender' : null,
        }
        const domainEvents: DomainEvent[] = []
        if (unique) {
          domainEvents.push({
            id: this.newId(), organizationId: unique.organizationId, eventType: 'message.received',
            aggregateType: 'inbound_message', aggregateId: inbound.id, occurredAt: input.event.occurredAt,
            payload: {
              inboundMessageId: inbound.id, eventId: unique.eventId, eventVendorId: unique.eventVendorId,
              sender: inbound.sender, provider: inbound.provider, contentType: inbound.content.type,
              text: inbound.content.type === 'text' ? inbound.content.text : null,
            },
          })
        } else if (candidates.length > 1) {
          const byOrganization = new Map<string, typeof candidates>()
          for (const candidate of candidates) {
            const current = byOrganization.get(candidate.organizationId) ?? []
            current.push(candidate)
            byOrganization.set(candidate.organizationId, current)
          }
          for (const [organizationId, organizationCandidates] of byOrganization) {
            const eventIds = [...new Set(organizationCandidates.map((candidate) => candidate.eventId))]
            domainEvents.push({
              id: this.newId(), organizationId, eventType: 'message.review_required',
              aggregateType: 'inbound_message', aggregateId: inbound.id, occurredAt: input.event.occurredAt,
              payload: {
                inboundMessageId: inbound.id, eventId: eventIds.length === 1 ? eventIds[0] : null,
                sender: inbound.sender, provider: inbound.provider, reason: inbound.lastError,
                candidateEventVendorIds: organizationCandidates.map((candidate) => candidate.eventVendorId),
              },
            })
          }
        }

        await this.store.createInboundMessageWithOutbox(inbound, domainEvents)
        await this.store.markWebhookEventProcessed(registered.receipt.id, now)
        return { duplicate, handled: true, status: inbound.status }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.markWebhookEventFailed(registered.receipt.id, message, this.now())
        throw error
      }
    }

    // message.status is safe to retry while the receipt is not terminal. This matters when
    // provider callbacks race the local transaction that stores externalMessageId, or when
    // processing failed after the durable receipt was inserted.
    if (duplicate && registered.receipt.status === 'processed') {
      return { duplicate: true, handled: true, status: 'processed' }
    }

    try {
      const result = await this.applyProviderStatus({
        provider: input.event.provider,
        externalMessageId: input.event.externalMessageId,
        status: input.event.status,
        occurredAt: input.event.occurredAt,
        raw: input.event.raw,
      })
      await this.store.markWebhookEventProcessed(registered.receipt.id, this.now())
      return { duplicate, handled: true, status: result.changed ? 'processed' : 'processed' }
    } catch (error) {
      if (error instanceof OutboundMessageNotFoundError) {
        await this.store.markWebhookEventIgnored(registered.receipt.id, error.message, this.now())
        return { duplicate, handled: false, status: 'ignored' }
      }
      const message = error instanceof Error ? error.message : String(error)
      await this.store.markWebhookEventFailed(registered.receipt.id, message, this.now())
      throw error
    }
  }

  getMessage(messageId: string): Promise<OutboundMessage | null> {
    return this.store.findMessageById(messageId)
  }

  private assertVendorConfirmationAction(action: AutomationActionRef): void {
    if (action.actionType !== VENDOR_CONFIRMATION_ACTION) {
      throw new MessagingValidationError(`Automation action ${action.id} is not ${VENDOR_CONFIRMATION_ACTION}`)
    }
    if (action.status === 'cancelled') throw new MessagingValidationError('Cancelled automation action cannot create an outbound message')
  }

  private domainEvent(message: OutboundMessage, eventType: string, payload: Record<string, unknown>, occurredAt = this.now()): DomainEvent {
    return {
      id: this.newId(),
      organizationId: message.organizationId,
      eventType,
      aggregateType: 'outbound_message',
      aggregateId: message.id,
      occurredAt,
      payload,
    }
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MessagingValidationError(message)
  return value.trim()
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) throw new MessagingValidationError('Vendor phone must contain between 10 and 15 digits')
  return digits
}

function buildVendorConfirmationMessage(input: { vendorName: string; eventName: string; eventStartAt: string; timezone: string }): string {
  const date = new Intl.DateTimeFormat('pt-BR', {
    timeZone: input.timezone,
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(input.eventStartAt))

  return [
    `Olá, ${input.vendorName}!`,
    '',
    `Estamos realizando a confirmação operacional do evento ${input.eventName}, em ${date}.`,
    '',
    'Precisamos confirmar sua participação e o horário previsto de chegada.',
    '',
    'Pode nos confirmar essas informações?',
  ].join('\n')
}
