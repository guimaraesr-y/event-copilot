import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration015DependencyEngine = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.createTable('dependency_evaluations')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('proposal_id', 'uuid', (col) => col.notNull().references('change_proposals.id').onDelete('cascade'))
      .addColumn('source_change_event_id', 'uuid', (col) => col.notNull())
      .addColumn('change_type', 'varchar(32)', (col) => col.notNull())
      .addColumn('impact_count', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('dependency_evaluations_change_type_check', sql`change_type in ('event_date','event_time','guest_count','venue')`)
      .addUniqueConstraint('dependency_evaluations_source_unique', ['organization_id','source_change_event_id'])
      .execute()

    await db.schema.createIndex('dependency_evaluations_proposal_idx')
      .on('dependency_evaluations').columns(['organization_id','proposal_id','created_at']).execute()

    await db.schema.createTable('dependency_impacts')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('proposal_id', 'uuid', (col) => col.notNull().references('change_proposals.id').onDelete('cascade'))
      .addColumn('source_change_event_id', 'uuid', (col) => col.notNull())
      .addColumn('rule_key', 'varchar(96)', (col) => col.notNull())
      .addColumn('dependency_type', 'varchar(48)', (col) => col.notNull())
      .addColumn('entity_type', 'varchar(32)', (col) => col.notNull())
      .addColumn('entity_id', 'uuid', (col) => col.notNull())
      .addColumn('action', 'varchar(24)', (col) => col.notNull())
      .addColumn('severity', 'varchar(16)', (col) => col.notNull())
      .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('open'))
      .addColumn('title', 'varchar(240)', (col) => col.notNull())
      .addColumn('description', 'text', (col) => col.notNull())
      .addColumn('current_value', 'jsonb', (col) => col.notNull())
      .addColumn('suggested_value', 'jsonb')
      .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addColumn('resolved_at', 'timestamptz')
      .addCheckConstraint('dependency_impacts_type_check', sql`dependency_type in ('task_due_date','milestone_due_date','vendor_schedule','vendor_reconfirmation','guest_capacity_review','venue_logistics_review','manual_schedule_review')`)
      .addCheckConstraint('dependency_impacts_entity_type_check', sql`entity_type in ('task','milestone','event_vendor','event')`)
      .addCheckConstraint('dependency_impacts_action_check', sql`action in ('suggest_update','review')`)
      .addCheckConstraint('dependency_impacts_severity_check', sql`severity in ('info','warning','critical')`)
      .addCheckConstraint('dependency_impacts_status_check', sql`status in ('open','applied','resolved','dismissed')`)
      .execute()

    await db.schema.createIndex('dependency_impacts_source_unique')
      .unique().on('dependency_impacts')
      .columns(['organization_id','source_change_event_id','rule_key','entity_type','entity_id']).execute()
    await db.schema.createIndex('dependency_impacts_event_status_idx')
      .on('dependency_impacts').columns(['organization_id','event_id','status']).execute()
    await db.schema.createIndex('dependency_impacts_proposal_idx')
      .on('dependency_impacts').columns(['organization_id','proposal_id','status']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('dependency_impacts').ifExists().execute()
    await db.schema.dropTable('dependency_evaluations').ifExists().execute()
  },
}
