import type { MessageProviderName, CanonicalMessageContent } from './message.ts'
import type { DomainEvent } from './outbox.ts'

export const INBOUND_MESSAGE_STATUSES = ['received','resolved','processing','processed','needs_review','ignored','failed'] as const
export type InboundMessageStatus = (typeof INBOUND_MESSAGE_STATUSES)[number]

export type SupplierResponseIntent = 'confirm' | 'decline' | 'undecided' | 'unknown'

export interface SupplierResponseInterpretation {
  intent: SupplierResponseIntent
  confidence: number
  arrivalTime: string | null
  teamSize: number | null
  reason: string | null
}

export interface InboundMessage {
  id: string
  organizationId: string | null
  webhookEventId: string
  provider: MessageProviderName
  externalMessageId: string
  sender: string
  recipient: string | null
  content: CanonicalMessageContent
  status: InboundMessageStatus
  resolvedEventId: string | null
  resolvedEventVendorId: string | null
  candidateEventVendorIds: string[]
  interpretation: SupplierResponseInterpretation | null
  receivedAt: Date
  processedAt: Date | null
  createdAt: Date
  updatedAt: Date
  lastError: string | null
}

export interface InboundResolutionCandidate {
  organizationId: string
  eventId: string
  eventVendorId: string
  vendorId: string
  outboundMessageId: string
  sentAt: Date
}

export interface InboundProcessingContext {
  organizationId: string
  eventId: string
  eventVendorId: string
  vendorId: string
  eventStartAt: Date
  timezone: string
}

export interface InboundMessageStore {
  findById(id: string): Promise<InboundMessage | null>
  getProcessingContext(message: InboundMessage): Promise<InboundProcessingContext | null>
  markProcessing(id: string, at: Date): Promise<InboundMessage>
  markProcessed(id: string, interpretation: SupplierResponseInterpretation, at: Date): Promise<InboundMessage>
  markNeedsReview(id: string, interpretation: SupplierResponseInterpretation | null, reason: string, at: Date, domainEvent?: DomainEvent): Promise<InboundMessage>
  markFailed(id: string, reason: string, at: Date): Promise<InboundMessage>
}

export interface SupplierResponseInterpreter {
  interpret(text: string): SupplierResponseInterpretation
}

export class InboundMessageNotFoundError extends Error {
  readonly code = 'INBOUND_MESSAGE_NOT_FOUND'
  constructor(message = 'Inbound message not found') { super(message); this.name = 'InboundMessageNotFoundError' }
}
