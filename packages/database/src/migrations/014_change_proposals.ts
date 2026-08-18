import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration014ChangeProposals = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.createTable('change_proposals')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('requested_by_sender', 'varchar(128)', (col) => col.notNull())
      .addColumn('decided_by_sender', 'varchar(128)')
      .addColumn('source_agent_turn_id', 'uuid', (col) => col.references('agent_turns.id').onDelete('set null'))
      .addColumn('idempotency_key', 'varchar(180)', (col) => col.notNull())
      .addColumn('type', 'varchar(32)', (col) => col.notNull())
      .addColumn('current_value', 'jsonb', (col) => col.notNull())
      .addColumn('proposed_value', 'jsonb', (col) => col.notNull())
      .addColumn('reason', 'text')
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('proposed'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addColumn('decided_at', 'timestamptz')
      .addColumn('applied_at', 'timestamptz')
      .addCheckConstraint('change_proposals_type_check', sql`type in ('event_date','event_time','guest_count','venue')`)
      .addCheckConstraint('change_proposals_status_check', sql`status in ('proposed','applied','rejected','cancelled')`)
      .addUniqueConstraint('change_proposals_org_idempotency_unique', ['organization_id','idempotency_key'])
      .execute()

    await db.schema.createIndex('change_proposals_event_status_idx')
      .on('change_proposals').columns(['organization_id','event_id','status','created_at']).execute()
    await db.schema.createIndex('change_proposals_sender_status_idx')
      .on('change_proposals').columns(['organization_id','requested_by_sender','status','created_at']).execute()

    await db.schema.createTable('change_proposal_impacts')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('proposal_id', 'uuid', (col) => col.notNull().references('change_proposals.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('category', 'varchar(32)', (col) => col.notNull())
      .addColumn('severity', 'varchar(16)', (col) => col.notNull())
      .addColumn('title', 'varchar(240)', (col) => col.notNull())
      .addColumn('description', 'text', (col) => col.notNull())
      .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('change_proposal_impacts_category_check', sql`category in ('schedule','vendor','task','milestone','guest','venue','logistics')`)
      .addCheckConstraint('change_proposal_impacts_severity_check', sql`severity in ('info','warning','critical')`)
      .execute()

    await db.schema.createIndex('change_proposal_impacts_proposal_idx')
      .on('change_proposal_impacts').columns(['organization_id','proposal_id']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('change_proposal_impacts').ifExists().execute()
    await db.schema.dropTable('change_proposals').ifExists().execute()
  },
}
