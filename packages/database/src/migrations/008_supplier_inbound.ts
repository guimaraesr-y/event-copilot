import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration008SupplierInbound = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('inbound_messages')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.references('organizations.id').onDelete('cascade'))
      .addColumn('webhook_event_id', 'uuid', (col) => col.notNull().references('messaging_webhook_events.id').onDelete('cascade'))
      .addColumn('provider', 'varchar(24)', (col) => col.notNull())
      .addColumn('external_message_id', 'varchar(512)', (col) => col.notNull())
      .addColumn('sender', 'varchar(64)', (col) => col.notNull())
      .addColumn('recipient', 'varchar(128)')
      .addColumn('content_type', 'varchar(24)', (col) => col.notNull())
      .addColumn('text', 'text')
      .addColumn('content', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('received'))
      .addColumn('resolved_event_id', 'uuid', (col) => col.references('events.id').onDelete('set null'))
      .addColumn('resolved_event_vendor_id', 'uuid', (col) => col.references('event_vendors.id').onDelete('set null'))
      .addColumn('candidate_event_vendor_ids', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('interpretation', 'jsonb')
      .addColumn('received_at', 'timestamptz', (col) => col.notNull())
      .addColumn('processed_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addColumn('last_error', 'text')
      .addCheckConstraint('inbound_messages_provider_check', sql`provider in ('mock','meta')`)
      .addCheckConstraint('inbound_messages_content_type_check', sql`content_type in ('text','media')`)
      .addCheckConstraint('inbound_messages_status_check', sql`status in ('received','resolved','processing','processed','needs_review','ignored','failed')`)
      .addUniqueConstraint('inbound_messages_provider_external_unique', ['provider','external_message_id'])
      .execute()

    await db.schema.createIndex('inbound_messages_status_idx').on('inbound_messages').columns(['status','received_at']).execute()
    await db.schema.createIndex('inbound_messages_sender_idx').on('inbound_messages').columns(['sender','received_at']).execute()
    await db.schema.createIndex('inbound_messages_event_vendor_idx').on('inbound_messages').columns(['resolved_event_vendor_id','received_at']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('inbound_messages').ifExists().execute()
  },
}
