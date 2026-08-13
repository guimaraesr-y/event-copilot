import type { Kysely, Selectable } from 'kysely'
import type {
  InboundMessage,
  InboundMessageStore,
  InboundProcessingContext,
  SupplierResponseInterpretation,
} from '@ecc/domain'
import type { DatabaseSchema, InboundMessagesTable } from '../db-types.ts'

export class KyselyInboundMessageStore implements InboundMessageStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async findById(id: string): Promise<InboundMessage | null> {
    const row = await this.db.selectFrom('inbound_messages').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? this.map(row) : null
  }

  async getProcessingContext(message: InboundMessage): Promise<InboundProcessingContext | null> {
    if (!message.organizationId || !message.resolvedEventId || !message.resolvedEventVendorId) return null
    const row = await this.db.selectFrom('event_vendors as ev')
      .innerJoin('events as e', (join) => join.onRef('e.id', '=', 'ev.event_id').onRef('e.organization_id', '=', 'ev.organization_id'))
      .innerJoin('organizations as o', 'o.id', 'ev.organization_id')
      .select([
        'ev.organization_id as organization_id', 'ev.event_id as event_id', 'ev.id as event_vendor_id',
        'ev.vendor_id as vendor_id', 'e.start_at as event_start_at', 'o.timezone as timezone',
      ])
      .where('ev.organization_id', '=', message.organizationId)
      .where('ev.event_id', '=', message.resolvedEventId)
      .where('ev.id', '=', message.resolvedEventVendorId)
      .executeTakeFirst()
    return row ? {
      organizationId: row.organization_id, eventId: row.event_id, eventVendorId: row.event_vendor_id,
      vendorId: row.vendor_id, eventStartAt: row.event_start_at, timezone: row.timezone,
    } : null
  }

  markProcessing(id: string, at: Date): Promise<InboundMessage> {
    return this.patch(id, { status: 'processing', updated_at: at, last_error: null })
  }

  markProcessed(id: string, interpretation: SupplierResponseInterpretation, at: Date): Promise<InboundMessage> {
    return this.patch(id, { status: 'processed', interpretation: interpretation as any, processed_at: at, updated_at: at, last_error: null })
  }

  markNeedsReview(id: string, interpretation: SupplierResponseInterpretation | null, reason: string, at: Date): Promise<InboundMessage> {
    return this.patch(id, { status: 'needs_review', interpretation: interpretation as any, processed_at: at, updated_at: at, last_error: reason })
  }

  markFailed(id: string, reason: string, at: Date): Promise<InboundMessage> {
    return this.patch(id, { status: 'failed', processed_at: at, updated_at: at, last_error: reason })
  }

  private async patch(id: string, values: Record<string, unknown>): Promise<InboundMessage> {
    const row = await this.db.updateTable('inbound_messages').set(values as any).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
    return this.map(row)
  }

  private map(row: Selectable<InboundMessagesTable>): InboundMessage {
    return {
      id: row.id, organizationId: row.organization_id, webhookEventId: row.webhook_event_id, provider: row.provider,
      externalMessageId: row.external_message_id, sender: row.sender, recipient: row.recipient, content: row.content as any,
      status: row.status, resolvedEventId: row.resolved_event_id, resolvedEventVendorId: row.resolved_event_vendor_id,
      candidateEventVendorIds: row.candidate_event_vendor_ids, interpretation: row.interpretation as any,
      receivedAt: row.received_at, processedAt: row.processed_at, createdAt: row.created_at, updatedAt: row.updated_at,
      lastError: row.last_error,
    }
  }
}
