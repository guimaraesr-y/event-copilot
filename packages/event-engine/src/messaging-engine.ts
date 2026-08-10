import type {
  AutomationActionRef,
  DomainEvent,
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
        this.domainEvent(claim.message, 'message.failed', { messageId: claim.message.id, provider: claim.message.provider, error: message }, now),
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
