import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration005OutboundMessaging = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await sql`alter table automation_actions drop constraint if exists automation_actions_status_check`.execute(db)
    await sql`alter table automation_actions add constraint automation_actions_status_check check (status in ('prepared','processing','completed','failed','cancelled'))`.execute(db)

    await db.schema
      .createTable('outbound_messages')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('source_action_id', 'uuid', (col) => col.notNull().references('automation_actions.id').onDelete('cascade').unique())
      .addColumn('channel', 'varchar(24)', (col) => col.notNull())
      .addColumn('provider', 'varchar(24)', (col) => col.notNull())
      .addColumn('recipient', 'varchar(80)', (col) => col.notNull())
      .addColumn('message_type', 'varchar(120)', (col) => col.notNull())
      .addColumn('aggregate_type', 'varchar(120)', (col) => col.notNull())
      .addColumn('aggregate_id', 'uuid', (col) => col.notNull())
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('pending'))
      .addColumn('external_message_id', 'varchar(255)')
      .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('provider_response', 'jsonb')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('sent_at', 'timestamptz')
      .addColumn('delivered_at', 'timestamptz')
      .addColumn('read_at', 'timestamptz')
      .addColumn('failed_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addCheckConstraint('outbound_messages_channel_check', sql`channel in ('whatsapp','email','sms')`)
      .addCheckConstraint('outbound_messages_provider_check', sql`provider in ('mock','meta')`)
      .addCheckConstraint('outbound_messages_status_check', sql`status in ('pending','sending','sent','delivered','read','failed')`)
      .execute()

    await db.schema.createIndex('outbound_messages_org_status_idx').on('outbound_messages').columns(['organization_id','status','created_at']).execute()
    await sql`create unique index outbound_messages_provider_external_unique on outbound_messages(provider, external_message_id) where external_message_id is not null`.execute(db)
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('outbound_messages').ifExists().execute()
    await sql`alter table automation_actions drop constraint if exists automation_actions_status_check`.execute(db)
    await sql`alter table automation_actions add constraint automation_actions_status_check check (status in ('prepared','completed','failed','cancelled'))`.execute(db)
  },
}
