import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration009OperationalInboxActivity = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('activity_entries')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.references('events.id').onDelete('cascade'))
      .addColumn('source_event_id', 'uuid', (col) => col.notNull())
      .addColumn('actor_type', 'varchar(24)', (col) => col.notNull())
      .addColumn('actor_id', 'varchar(128)')
      .addColumn('category', 'varchar(24)', (col) => col.notNull())
      .addColumn('action', 'varchar(120)', (col) => col.notNull())
      .addColumn('entity_type', 'varchar(64)', (col) => col.notNull())
      .addColumn('entity_id', 'uuid')
      .addColumn('title', 'varchar(300)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('activity_entries_actor_type_check', sql`actor_type in ('user','system','vendor','client','automation')`)
      .addCheckConstraint('activity_entries_category_check', sql`category in ('event','task','vendor','message','document','payment','change','risk','system')`)
      .addUniqueConstraint('activity_entries_source_event_unique', ['source_event_id'])
      .execute()

    await db.schema.createIndex('activity_entries_event_timeline_idx').on('activity_entries').columns(['organization_id','event_id','occurred_at']).execute()
    await db.schema.createIndex('activity_entries_category_idx').on('activity_entries').columns(['organization_id','category','occurred_at']).execute()

    await db.schema
      .createTable('inbox_items')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.references('events.id').onDelete('cascade'))
      .addColumn('source_event_id', 'uuid', (col) => col.notNull())
      .addColumn('type', 'varchar(80)', (col) => col.notNull())
      .addColumn('severity', 'varchar(16)', (col) => col.notNull())
      .addColumn('source_type', 'varchar(64)', (col) => col.notNull())
      .addColumn('source_id', 'uuid')
      .addColumn('title', 'varchar(300)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('open'))
      .addColumn('assigned_to', 'varchar(128)')
      .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addColumn('resolved_at', 'timestamptz')
      .addCheckConstraint('inbox_items_severity_check', sql`severity in ('info','warning','critical')`)
      .addCheckConstraint('inbox_items_status_check', sql`status in ('open','in_progress','resolved','dismissed')`)
      .addUniqueConstraint('inbox_items_source_type_unique', ['source_event_id','type'])
      .execute()

    await db.schema.createIndex('inbox_items_open_idx').on('inbox_items').columns(['organization_id','status','severity','created_at']).execute()
    await db.schema.createIndex('inbox_items_event_idx').on('inbox_items').columns(['organization_id','event_id','status','created_at']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('inbox_items').ifExists().execute()
    await db.schema.dropTable('activity_entries').ifExists().execute()
  },
}
