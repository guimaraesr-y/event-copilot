import type { InboundMessage, InboundMessageStore, SupplierResponseInterpreter } from '@ecc/domain'
import { InboundMessageNotFoundError } from '@ecc/domain'
import type { VendorEngine } from './vendor-engine.ts'
import { scheduleRelativeToEvent } from './schedule.ts'

export interface InboundEngineDependencies {
  store: InboundMessageStore
  vendorEngine: VendorEngine
  interpreter: SupplierResponseInterpreter
  now?: () => Date
}

export class InboundEngine {
  constructor(private readonly deps: InboundEngineDependencies) {}

  async process(messageId: string): Promise<{ message: InboundMessage; duplicate: boolean; action: string }> {
    const message = await this.deps.store.findById(messageId)
    if (!message) throw new InboundMessageNotFoundError()
    if (message.status === 'processed') return { message, duplicate: true, action: 'already_processed' }
    if (message.status === 'needs_review' || message.status === 'ignored') return { message, duplicate: true, action: message.status }

    const now = (this.deps.now ?? (() => new Date()))()
    const context = await this.deps.store.getProcessingContext(message)
    if (!context) {
      const updated = await this.deps.store.markNeedsReview(message.id, null, 'Inbound message has no unique event/vendor context', now)
      return { message: updated, duplicate: false, action: 'needs_review' }
    }
    if (message.content.type !== 'text') {
      const reason = 'Only text supplier responses are supported in Mini-feature 06'
      const updated = await this.deps.store.markNeedsReview(message.id, null, reason, now, this.reviewEvent(message, context, reason, now))
      return { message: updated, duplicate: false, action: 'needs_review' }
    }

    await this.deps.store.markProcessing(message.id, now)
    const interpretation = this.deps.interpreter.interpret(message.content.text)

    if (interpretation.confidence < 0.9 || interpretation.intent === 'unknown' || interpretation.intent === 'undecided') {
      const reason = `Supplier response requires review: ${interpretation.reason ?? interpretation.intent}`
      const updated = await this.deps.store.markNeedsReview(message.id, interpretation, reason, now, this.reviewEvent(message, context, reason, now))
      return { message: updated, duplicate: false, action: 'needs_review' }
    }

    try {
      if (interpretation.intent === 'confirm') {
        const arrivalAt = interpretation.arrivalTime
          ? scheduleRelativeToEvent(context.eventStartAt, 0, interpretation.arrivalTime, context.timezone)
          : undefined
        await this.deps.vendorEngine.confirm({
          organizationId: context.organizationId,
          eventId: context.eventId,
          eventVendorId: context.eventVendorId,
          arrivalAt,
          teamSize: interpretation.teamSize ?? undefined,
        })
      } else if (interpretation.intent === 'decline') {
        await this.deps.vendorEngine.decline({
          organizationId: context.organizationId,
          eventId: context.eventId,
          eventVendorId: context.eventVendorId,
        })
      }

      const updated = await this.deps.store.markProcessed(message.id, interpretation, (this.deps.now ?? (() => new Date()))())
      return { message: updated, duplicate: false, action: interpretation.intent }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.deps.store.markFailed(message.id, reason, (this.deps.now ?? (() => new Date()))())
      throw error
    }
  }

  private reviewEvent(message: InboundMessage, context: { organizationId: string; eventId: string; eventVendorId: string }, reason: string, occurredAt: Date) {
    return {
      id: crypto.randomUUID(), organizationId: context.organizationId, eventType: 'message.review_required',
      aggregateType: 'inbound_message', aggregateId: message.id, occurredAt,
      payload: { inboundMessageId: message.id, eventId: context.eventId, eventVendorId: context.eventVendorId, sender: message.sender, reason },
    }
  }
}
