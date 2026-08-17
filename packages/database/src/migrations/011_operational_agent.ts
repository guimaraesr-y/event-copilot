import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration011OperationalAgent = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .alterTable('command_requests')
      .dropConstraint('command_requests_interpreter_check')
      .execute()

    await db.schema
      .alterTable('command_requests')
      .addCheckConstraint('command_requests_interpreter_check', sql`interpreter in ('rule_based','ai','agent')`)
      .execute()

    await db.schema
      .createTable('agent_turns')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('sender', 'varchar(128)', (col) => col.notNull())
      .addColumn('idempotency_key', 'varchar(160)', (col) => col.notNull())
      .addColumn('user_text', 'text', (col) => col.notNull())
      .addColumn('explicit_event_id', 'uuid', (col) => col.references('events.id').onDelete('set null'))
      .addColumn('assistant_text', 'text')
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('received'))
      .addColumn('provider', 'varchar(24)', (col) => col.notNull())
      .addColumn('model', 'varchar(160)', (col) => col.notNull())
      .addColumn('model_calls', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('tool_trace', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addColumn('completed_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addCheckConstraint('agent_turns_status_check', sql`status in ('received','processing','completed','failed')`)
      .addCheckConstraint('agent_turns_provider_check', sql`provider in ('ollama','openai','gemini','deterministic')`)
      .addCheckConstraint('agent_turns_model_calls_check', sql`model_calls >= 0`)
      .addUniqueConstraint('agent_turns_org_idempotency_unique', ['organization_id','idempotency_key'])
      .execute()

    await db.schema.createIndex('agent_turns_sender_idx')
      .on('agent_turns').columns(['organization_id','sender','created_at']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('agent_turns').ifExists().execute()

    await db.schema
      .alterTable('command_requests')
      .dropConstraint('command_requests_interpreter_check')
      .execute()

    await db.schema
      .alterTable('command_requests')
      .addCheckConstraint('command_requests_interpreter_check', sql`interpreter in ('rule_based','ai')`)
      .execute()
  },
}
