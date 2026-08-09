import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration001Foundation = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('organizations')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('name', 'varchar(120)', (col) => col.notNull())
      .addColumn('timezone', 'varchar(80)', (col) => col.notNull().defaultTo('America/Sao_Paulo'))
      .addColumn('settings', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()

    await db.schema
      .createTable('events')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(160)', (col) => col.notNull())
      .addColumn('type', 'varchar(32)', (col) => col.notNull())
      .addColumn('start_at', 'timestamptz', (col) => col.notNull())
      .addColumn('end_at', 'timestamptz')
      .addColumn('venue_name', 'varchar(200)')
      .addColumn('venue_address', 'varchar(500)')
      .addColumn('guest_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('planning'))
      .addColumn('health_score', 'integer', (col) => col.notNull().defaultTo(100))
      .addColumn('owner_user_id', 'uuid')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('events_type_check', sql`type in ('wedding', 'birthday', 'corporate', 'other')`)
      .addCheckConstraint(
        'events_status_check',
        sql`status in ('draft', 'planning', 'confirmation', 'ready', 'event_day', 'completed', 'cancelled')`,
      )
      .addCheckConstraint('events_guest_count_check', sql`guest_count >= 0`)
      .addCheckConstraint('events_health_score_check', sql`health_score between 0 and 100`)
      .addCheckConstraint('events_dates_check', sql`end_at is null or end_at >= start_at`)
      .execute()

    await db.schema
      .createIndex('events_organization_start_idx')
      .on('events')
      .columns(['organization_id', 'start_at'])
      .execute()

    await db.schema
      .createTable('outbox_events')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade'),
      )
      .addColumn('event_type', 'varchar(120)', (col) => col.notNull())
      .addColumn('aggregate_type', 'varchar(80)', (col) => col.notNull())
      .addColumn('aggregate_id', 'uuid', (col) => col.notNull())
      .addColumn('payload', 'jsonb', (col) => col.notNull())
      .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('available_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('claimed_at', 'timestamptz')
      .addColumn('claimed_by', 'varchar(160)')
      .addColumn('dispatched_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .execute()

    await db.schema
      .createIndex('outbox_pending_idx')
      .on('outbox_events')
      .columns(['available_at', 'created_at'])
      .where('dispatched_at', 'is', null)
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('outbox_events').ifExists().execute()
    await db.schema.dropTable('events').ifExists().execute()
    await db.schema.dropTable('organizations').ifExists().execute()
  },
}
