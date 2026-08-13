import type { InboundMessage, InboundResolutionCandidate } from './inbound.ts'
import type { DomainEvent } from './outbox.ts'

export const MESSAGE_CHANNELS = ['whatsapp', 'email', 'sms'] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]

export const MESSAGE_PROVIDERS = ['mock', 'meta'] as const
export type MessageProviderName = (typeof MESSAGE_PROVIDERS)[number]

export const OUTBOUND_MESSAGE_STATUSES = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed'] as const
export type OutboundMessageStatus = (typeof OUTBOUND_MESSAGE_STATUSES)[number]

export const PROVIDER_MESSAGE_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const
export type ProviderMessageStatus = (typeof PROVIDER_MESSAGE_STATUSES)[number]

export interface AutomationActionRef {
  id: string
  organizationId: string
  actionType: string
  status: 'prepared' | 'processing' | 'completed' | 'failed' | 'cancelled'
  aggregateType: string
  aggregateId: string
  payload: Record<string, unknown>
}

export interface OutboundMessage {
  id: string
  organizationId: string
  sourceActionId: string
  channel: MessageChannel
  provider: MessageProviderName
  recipient: string
  messageType: string
  aggregateType: string
  aggregateId: string
  status: OutboundMessageStatus
  externalMessageId: string | null
  payload: Record<string, unknown>
  providerResponse: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
  sentAt: Date | null
  deliveredAt: Date | null
  readAt: Date | null
  failedAt: Date | null
  lastError: string | null
}

export interface SendResult {
  externalMessageId: string
  providerResponse?: Record<string, unknown> | null
}

export interface MessagingProvider {
  readonly name: MessageProviderName
  send(message: OutboundMessage): Promise<SendResult>
}

export interface ProviderStatusInput {
  provider: MessageProviderName
  externalMessageId: string
  status: ProviderMessageStatus
  occurredAt: Date
  raw?: Record<string, unknown>
}


export type MessagingWebhookEventStatus = 'received' | 'processed' | 'ignored' | 'failed'

export type CanonicalMessageContent =
  | { type: 'text'; text: string }
  | { type: 'media'; mediaType: string; mediaId: string | null; caption: string | null }

export type CanonicalMessagingWebhookEvent =
  | {
      type: 'message.status'
      provider: MessageProviderName
      externalEventId: string
      externalMessageId: string
      status: ProviderMessageStatus
      occurredAt: Date
      raw: Record<string, unknown>
    }
  | {
      type: 'message.received'
      provider: MessageProviderName
      externalEventId: string
      externalMessageId: string
      sender: string
      recipient: string | null
      occurredAt: Date
      content: CanonicalMessageContent
      raw: Record<string, unknown>
    }

export interface MessagingWebhookReceipt {
  id: string
  provider: MessageProviderName
  externalEventId: string
  eventType: CanonicalMessagingWebhookEvent['type']
  status: MessagingWebhookEventStatus
  payloadHash: string
  canonicalPayload: Record<string, unknown>
  rawPayload: Record<string, unknown>
  receivedAt: Date
  processedAt: Date | null
  lastError: string | null
}

export interface RegisterWebhookEventInput {
  event: CanonicalMessagingWebhookEvent
  payloadHash: string
  rawPayload: Record<string, unknown>
  receivedAt: Date
}

export interface RegisterWebhookEventResult {
  receipt: MessagingWebhookReceipt
  created: boolean
}

export interface ClaimMessageResult {
  state: 'claimed' | 'already_sent' | 'in_progress'
  message: OutboundMessage
}

export interface MessageStore {
  findAutomationAction(actionId: string): Promise<AutomationActionRef | null>
  getOrganizationTimezone(organizationId: string): Promise<string | null>
  findMessageBySourceAction(actionId: string): Promise<OutboundMessage | null>
  createMessageWithOutbox(message: OutboundMessage, domainEvent: DomainEvent): Promise<{ message: OutboundMessage; created: boolean }>
  claimForSend(messageId: string, at: Date): Promise<ClaimMessageResult | null>
  markSent(messageId: string, externalMessageId: string, providerResponse: Record<string, unknown> | null, at: Date, domainEvent: DomainEvent): Promise<OutboundMessage>
  markFailed(messageId: string, error: string, at: Date, domainEvent: DomainEvent): Promise<OutboundMessage>
  applyProviderStatus(input: ProviderStatusInput, domainEvent: DomainEvent): Promise<{ message: OutboundMessage; changed: boolean } | null>
  findMessageById(messageId: string): Promise<OutboundMessage | null>
  findMessageByExternalId(provider: MessageProviderName, externalMessageId: string): Promise<OutboundMessage | null>
  registerWebhookEvent(input: RegisterWebhookEventInput): Promise<RegisterWebhookEventResult>
  markWebhookEventProcessed(id: string, at: Date): Promise<void>
  markWebhookEventIgnored(id: string, reason: string, at: Date): Promise<void>
  markWebhookEventFailed(id: string, error: string, at: Date): Promise<void>
  findInboundCandidates(sender: string, receivedAt: Date): Promise<InboundResolutionCandidate[]>
  findInboundByProviderMessageId(provider: MessageProviderName, externalMessageId: string): Promise<InboundMessage | null>
  createInboundMessageWithOutbox(message: InboundMessage, domainEvent: DomainEvent | null): Promise<{ message: InboundMessage; created: boolean }>
}

export class MessagingValidationError extends Error {
  readonly code = 'MESSAGING_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'MessagingValidationError' }
}

export class AutomationActionNotFoundError extends Error {
  readonly code = 'AUTOMATION_ACTION_NOT_FOUND'
  constructor(message = 'Automation action not found') { super(message); this.name = 'AutomationActionNotFoundError' }
}

export class OutboundMessageNotFoundError extends Error {
  readonly code = 'OUTBOUND_MESSAGE_NOT_FOUND'
  constructor(message = 'Outbound message not found') { super(message); this.name = 'OutboundMessageNotFoundError' }
}

export class MessageSendInProgressError extends Error {
  readonly code = 'MESSAGE_SEND_IN_PROGRESS'
  constructor(message = 'Outbound message is already being sent') { super(message); this.name = 'MessageSendInProgressError' }
}

export class MessagingProviderError extends Error {
  readonly code = 'MESSAGING_PROVIDER_ERROR'
  constructor(message: string) { super(message); this.name = 'MessagingProviderError' }
}
