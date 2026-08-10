import type { Kysely, Selectable } from 'kysely'
import type { DomainEventEnvelope } from '@ecc/contracts'
import type { AutomationActionsTable, DatabaseSchema } from '../db-types.ts'

export interface AutomationAction {
  id: string
  organizationId: string
  sourceOutboxEventId: string
  sourceEventType: string
  aggregateType: string
  aggregateId: string
  actionType: string
  status: 'prepared' | 'processing' | 'completed' | 'failed' | 'cancelled'
  payload: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export class DomainEventGatewayRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async matchesOutbox(envelope: DomainEventEnvelope): Promise<boolean> {
    const row = await this.db
      .selectFrom('outbox_events')
      .select('id')
      .where('id', '=', envelope.id)
      .where('organization_id', '=', envelope.organizationId)
      .where('event_type', '=', envelope.eventType)
      .where('aggregate_type', '=', envelope.aggregateType)
      .where('aggregate_id', '=', envelope.aggregateId)
      .executeTakeFirst()
    return Boolean(row)
  }

  async prepareAction(envelope: DomainEventEnvelope, actionType: string): Promise<{ action: AutomationAction; created: boolean }> {
    const id = crypto.randomUUID()
    const now = new Date()
    let payload = envelope.payload
    if (actionType === 'vendor_confirmation.prepare' && typeof envelope.payload.eventId === 'string') {
      const event = await this.db.selectFrom('events').select(['name', 'start_at'])
        .where('organization_id', '=', envelope.organizationId)
        .where('id', '=', envelope.payload.eventId)
        .executeTakeFirst()
      if (event) payload = { ...payload, eventName: event.name, eventStartAt: event.start_at.toISOString() }
    }
    const inserted = await this.db
      .insertInto('automation_actions')
      .values({
        id,
        organization_id: envelope.organizationId,
        source_outbox_event_id: envelope.id,
        source_event_type: envelope.eventType,
        aggregate_type: envelope.aggregateType,
        aggregate_id: envelope.aggregateId,
        action_type: actionType,
        status: 'prepared',
        payload,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['source_outbox_event_id', 'action_type']).doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) return { action: this.map(inserted), created: true }

    const existing = await this.db
      .selectFrom('automation_actions')
      .selectAll()
      .where('source_outbox_event_id', '=', envelope.id)
      .where('action_type', '=', actionType)
      .executeTakeFirstOrThrow()
    return { action: this.map(existing), created: false }
  }

  private map(row: Selectable<AutomationActionsTable>): AutomationAction {
    return {
      id: row.id,
      organizationId: row.organization_id,
      sourceOutboxEventId: row.source_outbox_event_id,
      sourceEventType: row.source_event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      actionType: row.action_type,
      status: row.status,
      payload: row.payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
