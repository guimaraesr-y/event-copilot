import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration010CommandEngine = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('command_requests')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('sender', 'varchar(128)', (col) => col.notNull())
      .addColumn('idempotency_key', 'varchar(160)', (col) => col.notNull())
      .addColumn('raw_text', 'text', (col) => col.notNull())
      .addColumn('explicit_event_id', 'uuid', (col) => col.references('events.id').onDelete('set null'))
      .addColumn('resolved_event_id', 'uuid', (col) => col.references('events.id').onDelete('set null'))
      .addColumn('interpreter', 'varchar(24)', (col) => col.notNull())
      .addColumn('intent', 'varchar(64)')
      .addColumn('confidence', 'double precision')
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('received'))
      .addColumn('interpretation', 'jsonb')
      .addColumn('result', 'jsonb')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addColumn('processed_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addCheckConstraint('command_requests_interpreter_check', sql`interpreter in ('rule_based','ai')`)
      .addCheckConstraint('command_requests_status_check', sql`status in ('received','processing','processed','needs_review','rejected','failed')`)
      .addCheckConstraint('command_requests_confidence_check', sql`confidence is null or (confidence >= 0 and confidence <= 1)`)
      .addUniqueConstraint('command_requests_org_idempotency_unique', ['organization_id','idempotency_key'])
      .execute()

    await db.schema.createIndex('command_requests_sender_idx').on('command_requests').columns(['organization_id','sender','created_at']).execute()
    await db.schema.createIndex('command_requests_event_idx').on('command_requests').columns(['organization_id','resolved_event_id','created_at']).execute()

    await db.schema
      .createTable('conversation_contexts')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('sender', 'varchar(128)', (col) => col.notNull())
      .addColumn('current_event_id', 'uuid', (col) => col.references('events.id').onDelete('set null'))
      .addColumn('last_interaction_at', 'timestamptz', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addUniqueConstraint('conversation_contexts_org_sender_unique', ['organization_id','sender'])
      .execute()

    await db.schema.createIndex('conversation_contexts_event_idx').on('conversation_contexts').columns(['organization_id','current_event_id']).execute()

    await db.schema
      .createTable('event_notes')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('source_command_request_id', 'uuid', (col) => col.notNull().references('command_requests.id').onDelete('cascade'))
      .addColumn('body', 'text', (col) => col.notNull())
      .addColumn('created_by_sender', 'varchar(128)', (col) => col.notNull())
      .addColumn('source', 'varchar(24)', (col) => col.notNull().defaultTo('command'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('event_notes_source_check', sql`source in ('command')`)
      .addUniqueConstraint('event_notes_command_request_unique', ['source_command_request_id'])
      .execute()

    await db.schema.createIndex('event_notes_event_idx').on('event_notes').columns(['organization_id','event_id','created_at']).execute()

    await db.schema
      .alterTable('event_tasks')
      .addColumn('source_command_request_id', 'uuid', (col) => col.references('command_requests.id').onDelete('set null'))
      .addUniqueConstraint('event_tasks_command_request_unique', ['source_command_request_id'])
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.alterTable('event_tasks').dropConstraint('event_tasks_command_request_unique').execute()
    await db.schema.alterTable('event_tasks').dropColumn('source_command_request_id').execute()
    await db.schema.dropTable('event_notes').ifExists().execute()
    await db.schema.dropTable('conversation_contexts').ifExists().execute()
    await db.schema.dropTable('command_requests').ifExists().execute()
  },
}
