import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration004DomainEventGateway = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('automation_actions')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('source_outbox_event_id', 'uuid', (col) => col.notNull().references('outbox_events.id').onDelete('cascade'))
      .addColumn('source_event_type', 'varchar(120)', (col) => col.notNull())
      .addColumn('aggregate_type', 'varchar(120)', (col) => col.notNull())
      .addColumn('aggregate_id', 'uuid', (col) => col.notNull())
      .addColumn('action_type', 'varchar(120)', (col) => col.notNull())
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('prepared'))
      .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('automation_actions_source_action_unique', ['source_outbox_event_id', 'action_type'])
      .addCheckConstraint('automation_actions_status_check', sql`status in ('prepared','completed','failed','cancelled')`)
      .execute()

    await db.schema
      .createIndex('automation_actions_org_status_idx')
      .on('automation_actions')
      .columns(['organization_id', 'status', 'created_at'])
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('automation_actions').ifExists().execute()
  },
}
