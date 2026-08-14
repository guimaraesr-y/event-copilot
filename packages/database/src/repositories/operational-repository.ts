import type { Kysely, Selectable } from 'kysely'
import type { ActivityEntry, InboxItem, InboxSeverity, InboxStatus, OperationalProjection, OutboxMessage } from '@ecc/domain'
import type { ActivityEntriesTable, DatabaseSchema, InboxItemsTable } from '../db-types.ts'

export class OperationalRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async applyProjection(message: OutboxMessage, projection: OperationalProjection, at = new Date()): Promise<void> {
    if (!projection.activity && !projection.inbox) return
    await this.db.transaction().execute(async (trx) => {
      if (projection.activity) {
        const a = projection.activity
        await trx.insertInto('activity_entries').values({
          id: crypto.randomUUID(), organization_id: message.organizationId, event_id: a.eventId,
          source_event_id: message.id, actor_type: a.actorType, actor_id: a.actorId, category: a.category,
          action: a.action, entity_type: a.entityType, entity_id: a.entityId, title: a.title,
          description: a.description, metadata: a.metadata, occurred_at: message.occurredAt, created_at: at,
        }).onConflict((oc) => oc.column('source_event_id').doNothing()).execute()
      }
      if (projection.inbox) {
        const i = projection.inbox
        await trx.insertInto('inbox_items').values({
          id: crypto.randomUUID(), organization_id: message.organizationId, event_id: i.eventId,
          source_event_id: message.id, type: i.type, severity: i.severity, source_type: i.sourceType,
          source_id: i.sourceId, title: i.title, description: i.description, status: 'open',
          assigned_to: i.assignedTo, metadata: i.metadata, created_at: at, updated_at: at, resolved_at: null,
        }).onConflict((oc) => oc.columns(['source_event_id','type']).doNothing()).execute()
      }
    })
  }

  async eventExists(organizationId: string, eventId: string): Promise<boolean> {
    const row = await this.db.selectFrom('events').select('id').where('organization_id', '=', organizationId).where('id', '=', eventId).executeTakeFirst()
    return Boolean(row)
  }

  async listActivity(input: { organizationId: string; eventId: string; category?: ActivityEntry['category']; limit?: number }): Promise<ActivityEntry[]> {
    let query = this.db.selectFrom('activity_entries').selectAll()
      .where('organization_id', '=', input.organizationId).where('event_id', '=', input.eventId)
    if (input.category) query = query.where('category', '=', input.category)
    const rows = await query.orderBy('occurred_at', 'desc').orderBy('created_at', 'desc').limit(clampLimit(input.limit)).execute()
    return rows.map(mapActivity)
  }

  async listInbox(input: { organizationId: string; status?: InboxStatus; severity?: InboxSeverity; eventId?: string; limit?: number }): Promise<InboxItem[]> {
    let query = this.db.selectFrom('inbox_items').selectAll().where('organization_id', '=', input.organizationId)
    if (input.status) query = query.where('status', '=', input.status)
    if (input.severity) query = query.where('severity', '=', input.severity)
    if (input.eventId) query = query.where('event_id', '=', input.eventId)
    const rows = await query.orderBy('created_at', 'desc').limit(clampLimit(input.limit)).execute()
    return rows.map(mapInbox)
  }

  async findInboxItem(organizationId: string, id: string): Promise<InboxItem | null> {
    const row = await this.db.selectFrom('inbox_items').selectAll().where('organization_id', '=', organizationId).where('id', '=', id).executeTakeFirst()
    return row ? mapInbox(row) : null
  }

  async resolveInboxItem(organizationId: string, id: string, at = new Date()): Promise<InboxItem | null> {
    const existing = await this.findInboxItem(organizationId, id)
    if (!existing) return null
    if (existing.status === 'resolved') return existing
    const row = await this.db.updateTable('inbox_items').set({ status: 'resolved', resolved_at: at, updated_at: at })
      .where('organization_id', '=', organizationId).where('id', '=', id).returningAll().executeTakeFirst()
    return row ? mapInbox(row) : null
  }

  async dismissInboxItem(organizationId: string, id: string, at = new Date()): Promise<InboxItem | null> {
    const existing = await this.findInboxItem(organizationId, id)
    if (!existing) return null
    if (existing.status === 'dismissed') return existing
    const row = await this.db.updateTable('inbox_items').set({ status: 'dismissed', resolved_at: at, updated_at: at })
      .where('organization_id', '=', organizationId).where('id', '=', id).returningAll().executeTakeFirst()
    return row ? mapInbox(row) : null
  }
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isInteger(value) || value < 1) return 50
  return Math.min(value, 200)
}
function mapActivity(row: Selectable<ActivityEntriesTable>): ActivityEntry {
  return { id: row.id, organizationId: row.organization_id, eventId: row.event_id, sourceEventId: row.source_event_id,
    actorType: row.actor_type, actorId: row.actor_id, category: row.category, action: row.action, entityType: row.entity_type,
    entityId: row.entity_id, title: row.title, description: row.description, metadata: row.metadata,
    occurredAt: row.occurred_at, createdAt: row.created_at }
}
function mapInbox(row: Selectable<InboxItemsTable>): InboxItem {
  return { id: row.id, organizationId: row.organization_id, eventId: row.event_id, sourceEventId: row.source_event_id,
    type: row.type, severity: row.severity, sourceType: row.source_type, sourceId: row.source_id, title: row.title,
    description: row.description, status: row.status, assignedTo: row.assigned_to, metadata: row.metadata,
    createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at }
}
