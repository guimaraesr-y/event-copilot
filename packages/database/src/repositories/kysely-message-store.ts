import type { Kysely, Selectable, Transaction } from 'kysely'
import type {
  AutomationActionRef,
  InboundMessage,
  InboundResolutionCandidate,
  ClaimMessageResult,
  DomainEvent,
  MessageProviderName,
  MessageStore,
  MessagingWebhookReceipt,
  RegisterWebhookEventInput,
  RegisterWebhookEventResult,
  OutboundMessage,
  ProviderStatusInput,
} from '@ecc/domain'
import type { AutomationActionsTable, DatabaseSchema, InboundMessagesTable, MessagingWebhookEventsTable, OutboundMessagesTable } from '../db-types.ts'

const RANK: Record<string, number> = { pending: 0, sending: 1, sent: 2, delivered: 3, read: 4 }

export class KyselyMessageStore implements MessageStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async findAutomationAction(actionId: string): Promise<AutomationActionRef | null> {
    const row = await this.db.selectFrom('automation_actions').selectAll().where('id', '=', actionId).executeTakeFirst()
    return row ? this.mapAction(row) : null
  }

  async getOrganizationTimezone(organizationId: string): Promise<string | null> {
    const row = await this.db.selectFrom('organizations').select('timezone').where('id', '=', organizationId).executeTakeFirst()
    return row?.timezone ?? null
  }

  async findMessageBySourceAction(actionId: string): Promise<OutboundMessage | null> {
    const row = await this.db.selectFrom('outbound_messages').selectAll().where('source_action_id', '=', actionId).executeTakeFirst()
    return row ? this.mapMessage(row) : null
  }

  async findMessageById(messageId: string): Promise<OutboundMessage | null> {
    const row = await this.db.selectFrom('outbound_messages').selectAll().where('id', '=', messageId).executeTakeFirst()
    return row ? this.mapMessage(row) : null
  }

  async findMessageByExternalId(provider: MessageProviderName, externalMessageId: string): Promise<OutboundMessage | null> {
    const row = await this.db.selectFrom('outbound_messages').selectAll()
      .where('provider', '=', provider).where('external_message_id', '=', externalMessageId).executeTakeFirst()
    return row ? this.mapMessage(row) : null
  }

  async findInboundCandidates(sender: string, receivedAt: Date): Promise<InboundResolutionCandidate[]> {
    const normalized = sender.replace(/\D/g, '')
    const since = new Date(receivedAt.getTime() - 7 * 24 * 60 * 60 * 1000)
    const rows = await this.db.selectFrom('outbound_messages as om')
      .innerJoin('event_vendors as ev', (join) => join.onRef('ev.id', '=', 'om.aggregate_id').onRef('ev.organization_id', '=', 'om.organization_id'))
      .select([
        'om.organization_id as organization_id', 'ev.event_id as event_id', 'ev.id as event_vendor_id',
        'ev.vendor_id as vendor_id', 'om.id as outbound_message_id', 'om.sent_at as sent_at',
      ])
      .where('om.aggregate_type', '=', 'event_vendor')
      .where('om.message_type', '=', 'vendor_confirmation')
      .where('om.recipient', '=', normalized)
      .where('om.status', 'in', ['sent','delivered','read'])
      .where('om.sent_at', '>=', since)
      .where('ev.confirmation_status', '=', 'requested')
      .orderBy('om.sent_at', 'desc')
      .execute()

    const seen = new Set<string>()
    const result: InboundResolutionCandidate[] = []
    for (const row of rows) {
      if (!row.sent_at || seen.has(row.event_vendor_id)) continue
      seen.add(row.event_vendor_id)
      result.push({
        organizationId: row.organization_id, eventId: row.event_id, eventVendorId: row.event_vendor_id,
        vendorId: row.vendor_id, outboundMessageId: row.outbound_message_id, sentAt: row.sent_at,
      })
    }
    return result
  }

  async findInboundByProviderMessageId(provider: MessageProviderName, externalMessageId: string): Promise<InboundMessage | null> {
    const row = await this.db.selectFrom('inbound_messages').selectAll()
      .where('provider', '=', provider).where('external_message_id', '=', externalMessageId).executeTakeFirst()
    return row ? this.mapInbound(row) : null
  }

  async createInboundMessageWithOutbox(message: InboundMessage, domainEvent: DomainEvent | null): Promise<{ message: InboundMessage; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto('inbound_messages').values(this.inboundValues(message))
        .onConflict((oc) => oc.columns(['provider','external_message_id']).doNothing()).returningAll().executeTakeFirst()
      if (!inserted) {
        const existing = await trx.selectFrom('inbound_messages').selectAll()
          .where('provider', '=', message.provider).where('external_message_id', '=', message.externalMessageId).executeTakeFirstOrThrow()
        return { message: this.mapInbound(existing), created: false }
      }
      if (domainEvent) await this.insertOutbox(trx, domainEvent)
      return { message: this.mapInbound(inserted), created: true }
    })
  }

  async registerWebhookEvent(input: RegisterWebhookEventInput): Promise<RegisterWebhookEventResult> {
    const canonicalPayload = serializeCanonicalWebhookEvent(input.event)
    const values = {
      id: crypto.randomUUID(),
      provider: input.event.provider,
      external_event_id: input.event.externalEventId,
      event_type: input.event.type,
      status: 'received' as const,
      payload_hash: input.payloadHash,
      canonical_payload: canonicalPayload,
      raw_payload: input.rawPayload,
      received_at: input.receivedAt,
      processed_at: null,
      last_error: null,
    }
    const inserted = await this.db.insertInto('messaging_webhook_events').values(values)
      .onConflict((oc) => oc.columns(['provider', 'external_event_id']).doNothing()).returningAll().executeTakeFirst()
    if (inserted) return { receipt: this.mapWebhookReceipt(inserted), created: true }
    const existing = await this.db.selectFrom('messaging_webhook_events').selectAll()
      .where('provider', '=', input.event.provider).where('external_event_id', '=', input.event.externalEventId).executeTakeFirstOrThrow()
    return { receipt: this.mapWebhookReceipt(existing), created: false }
  }

  async markWebhookEventProcessed(id: string, at: Date): Promise<void> {
    await this.db.updateTable('messaging_webhook_events').set({ status: 'processed', processed_at: at, last_error: null }).where('id', '=', id).execute()
  }

  async markWebhookEventIgnored(id: string, reason: string, at: Date): Promise<void> {
    await this.db.updateTable('messaging_webhook_events').set({ status: 'ignored', processed_at: at, last_error: reason }).where('id', '=', id).execute()
  }

  async markWebhookEventFailed(id: string, error: string, at: Date): Promise<void> {
    await this.db.updateTable('messaging_webhook_events').set({ status: 'failed', processed_at: at, last_error: error }).where('id', '=', id).execute()
  }

  async createMessageWithOutbox(message: OutboundMessage, domainEvent: DomainEvent): Promise<{ message: OutboundMessage; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto('outbound_messages').values(this.values(message))
        .onConflict((oc) => oc.column('source_action_id').doNothing()).returningAll().executeTakeFirst()
      if (!inserted) {
        const existing = await trx.selectFrom('outbound_messages').selectAll().where('source_action_id', '=', message.sourceActionId).executeTakeFirstOrThrow()
        return { message: this.mapMessage(existing), created: false }
      }
      await trx.updateTable('automation_actions').set({ status: 'processing', updated_at: message.createdAt }).where('id', '=', message.sourceActionId).execute()
      await this.insertOutbox(trx, domainEvent)
      return { message: this.mapMessage(inserted), created: true }
    })
  }

  async claimForSend(messageId: string, at: Date): Promise<ClaimMessageResult | null> {
    return this.db.transaction().execute(async (trx) => {
      const claimed = await trx.updateTable('outbound_messages')
        .set({ status: 'sending', updated_at: at, failed_at: null, last_error: null })
        .where('id', '=', messageId).where('status', 'in', ['pending', 'failed']).returningAll().executeTakeFirst()
      if (claimed) {
        await trx.updateTable('automation_actions').set({ status: 'processing', updated_at: at }).where('id', '=', claimed.source_action_id).execute()
        return { state: 'claimed', message: this.mapMessage(claimed) }
      }
      const existing = await trx.selectFrom('outbound_messages').selectAll().where('id', '=', messageId).executeTakeFirst()
      if (!existing) return null
      if (['sent','delivered','read'].includes(existing.status)) return { state: 'already_sent', message: this.mapMessage(existing) }
      return { state: 'in_progress', message: this.mapMessage(existing) }
    })
  }

  async markSent(messageId: string, externalMessageId: string, providerResponse: Record<string, unknown> | null, at: Date, domainEvent: DomainEvent): Promise<OutboundMessage> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.updateTable('outbound_messages').set({
        status: 'sent', external_message_id: externalMessageId, provider_response: providerResponse,
        sent_at: at, updated_at: at, failed_at: null, last_error: null,
      }).where('id', '=', messageId).returningAll().executeTakeFirstOrThrow()
      await trx.updateTable('automation_actions').set({ status: 'completed', updated_at: at }).where('id', '=', row.source_action_id).execute()
      await this.insertOutbox(trx, domainEvent)
      return this.mapMessage(row)
    })
  }

  async markFailed(messageId: string, error: string, at: Date, domainEvent: DomainEvent): Promise<OutboundMessage> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.updateTable('outbound_messages').set({ status: 'failed', failed_at: at, updated_at: at, last_error: error })
        .where('id', '=', messageId).returningAll().executeTakeFirstOrThrow()
      await trx.updateTable('automation_actions').set({ status: 'failed', updated_at: at }).where('id', '=', row.source_action_id).execute()
      await this.insertOutbox(trx, domainEvent)
      return this.mapMessage(row)
    })
  }

  async applyProviderStatus(input: ProviderStatusInput, domainEvent: DomainEvent): Promise<{ message: OutboundMessage; changed: boolean } | null> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('outbound_messages').selectAll()
        .where('provider', '=', input.provider).where('external_message_id', '=', input.externalMessageId).forUpdate().executeTakeFirst()
      if (!current) return null

      const currentRank = RANK[current.status] ?? -1
      const targetRank = RANK[input.status] ?? -1
      if (input.status !== 'failed' && targetRank <= currentRank) return { message: this.mapMessage(current), changed: false }
      if (input.status === 'failed' && ['delivered','read','failed'].includes(current.status)) return { message: this.mapMessage(current), changed: false }

      const patch: Record<string, unknown> = { status: input.status, updated_at: input.occurredAt }
      if (input.status === 'sent') patch.sent_at = current.sent_at ?? input.occurredAt
      if (input.status === 'delivered') patch.delivered_at = input.occurredAt
      if (input.status === 'read') { patch.delivered_at = current.delivered_at ?? input.occurredAt; patch.read_at = input.occurredAt }
      if (input.status === 'failed') { patch.failed_at = input.occurredAt; patch.last_error = 'Provider reported delivery failure' }
      if (input.raw) patch.provider_response = input.raw

      const updated = await trx.updateTable('outbound_messages').set(patch as any).where('id', '=', current.id).returningAll().executeTakeFirstOrThrow()
      if (input.status === 'failed') {
        await trx.updateTable('automation_actions').set({ status: 'failed', updated_at: input.occurredAt }).where('id', '=', current.source_action_id).execute()
      }
      await this.insertOutbox(trx, domainEvent)
      return { message: this.mapMessage(updated), changed: true }
    })
  }

  private mapWebhookReceipt(row: Selectable<MessagingWebhookEventsTable>): MessagingWebhookReceipt {
    return {
      id: row.id, provider: row.provider, externalEventId: row.external_event_id, eventType: row.event_type, status: row.status,
      payloadHash: row.payload_hash, canonicalPayload: row.canonical_payload, rawPayload: row.raw_payload,
      receivedAt: row.received_at, processedAt: row.processed_at, lastError: row.last_error,
    }
  }

  private values(message: OutboundMessage) {
    return {
      id: message.id, organization_id: message.organizationId, source_action_id: message.sourceActionId,
      channel: message.channel, provider: message.provider, recipient: message.recipient, message_type: message.messageType,
      aggregate_type: message.aggregateType, aggregate_id: message.aggregateId, status: message.status,
      external_message_id: message.externalMessageId, payload: message.payload, provider_response: message.providerResponse,
      created_at: message.createdAt, updated_at: message.updatedAt, sent_at: message.sentAt, delivered_at: message.deliveredAt,
      read_at: message.readAt, failed_at: message.failedAt, last_error: message.lastError,
    }
  }

  private mapAction(row: Selectable<AutomationActionsTable>): AutomationActionRef {
    return { id: row.id, organizationId: row.organization_id, actionType: row.action_type, status: row.status,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, payload: row.payload }
  }

  private mapMessage(row: Selectable<OutboundMessagesTable>): OutboundMessage {
    return {
      id: row.id, organizationId: row.organization_id, sourceActionId: row.source_action_id, channel: row.channel,
      provider: row.provider, recipient: row.recipient, messageType: row.message_type, aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id, status: row.status, externalMessageId: row.external_message_id, payload: row.payload,
      providerResponse: row.provider_response, createdAt: row.created_at, updatedAt: row.updated_at, sentAt: row.sent_at,
      deliveredAt: row.delivered_at, readAt: row.read_at, failedAt: row.failed_at, lastError: row.last_error,
    }
  }

  private inboundValues(message: InboundMessage) {
    return {
      id: message.id, organization_id: message.organizationId, webhook_event_id: message.webhookEventId,
      provider: message.provider, external_message_id: message.externalMessageId, sender: message.sender, recipient: message.recipient,
      content_type: message.content.type, text: message.content.type === 'text' ? message.content.text : null,
      content: message.content as any, status: message.status, resolved_event_id: message.resolvedEventId,
      resolved_event_vendor_id: message.resolvedEventVendorId, candidate_event_vendor_ids: message.candidateEventVendorIds,
      interpretation: message.interpretation as any, received_at: message.receivedAt, processed_at: message.processedAt,
      created_at: message.createdAt, updated_at: message.updatedAt, last_error: message.lastError,
    }
  }

  private mapInbound(row: Selectable<InboundMessagesTable>): InboundMessage {
    return {
      id: row.id, organizationId: row.organization_id, webhookEventId: row.webhook_event_id, provider: row.provider,
      externalMessageId: row.external_message_id, sender: row.sender, recipient: row.recipient, content: row.content as any,
      status: row.status, resolvedEventId: row.resolved_event_id, resolvedEventVendorId: row.resolved_event_vendor_id,
      candidateEventVendorIds: row.candidate_event_vendor_ids, interpretation: row.interpretation as any,
      receivedAt: row.received_at, processedAt: row.processed_at, createdAt: row.created_at, updatedAt: row.updated_at,
      lastError: row.last_error,
    }
  }

  private async insertOutbox(trx: Transaction<DatabaseSchema>, event: DomainEvent): Promise<void> {
    await trx.insertInto('outbox_events').values({
      id: event.id, organization_id: event.organizationId, event_type: event.eventType, aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId, payload: event.payload, occurred_at: event.occurredAt, available_at: event.occurredAt,
      claimed_at: null, claimed_by: null, dispatched_at: null, last_error: null,
    }).execute()
  }
}

function serializeCanonicalWebhookEvent(event: import('@ecc/domain').CanonicalMessagingWebhookEvent): Record<string, unknown> {
  if (event.type === 'message.status') return {
    type: event.type, provider: event.provider, externalEventId: event.externalEventId, externalMessageId: event.externalMessageId,
    status: event.status, occurredAt: event.occurredAt.toISOString(),
  }
  return {
    type: event.type, provider: event.provider, externalEventId: event.externalEventId, externalMessageId: event.externalMessageId,
    sender: event.sender, recipient: event.recipient, occurredAt: event.occurredAt.toISOString(), content: event.content,
  }
}
