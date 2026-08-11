import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration006MessagingWebhooks = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await sql`alter table outbound_messages drop constraint if exists outbound_messages_provider_check`.execute(db)
    await sql`alter table outbound_messages add constraint outbound_messages_provider_check check (provider in ('mock','meta'))`.execute(db)

    await db.schema
      .createTable('messaging_webhook_events')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('provider', 'varchar(24)', (col) => col.notNull())
      .addColumn('external_event_id', 'varchar(512)', (col) => col.notNull())
      .addColumn('event_type', 'varchar(64)', (col) => col.notNull())
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('received'))
      .addColumn('payload_hash', 'varchar(64)', (col) => col.notNull())
      .addColumn('canonical_payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('raw_payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('received_at', 'timestamptz', (col) => col.notNull())
      .addColumn('processed_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addCheckConstraint('messaging_webhook_events_provider_check', sql`provider in ('mock','meta')`)
      .addCheckConstraint('messaging_webhook_events_type_check', sql`event_type in ('message.status','message.received')`)
      .addCheckConstraint('messaging_webhook_events_status_check', sql`status in ('received','processed','ignored','failed')`)
      .addUniqueConstraint('messaging_webhook_events_provider_external_unique', ['provider', 'external_event_id'])
      .execute()

    await db.schema.createIndex('messaging_webhook_events_status_idx').on('messaging_webhook_events').columns(['provider','status','received_at']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('messaging_webhook_events').ifExists().execute()
    await sql`alter table outbound_messages drop constraint if exists outbound_messages_provider_check`.execute(db)
    await sql`alter table outbound_messages add constraint outbound_messages_provider_check check (provider in ('mock','meta'))`.execute(db)
  },
}
