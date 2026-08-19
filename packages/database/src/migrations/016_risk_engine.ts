import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration016RiskEngine = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.createTable('risk_evaluations')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('trigger_type', 'varchar(24)', (col) => col.notNull())
      .addColumn('trigger_key', 'varchar(220)', (col) => col.notNull())
      .addColumn('detected_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('updated_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('resolved_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('active_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('evaluated_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('risk_evaluations_trigger_type_check', sql`trigger_type in ('domain_event','scheduled','manual')`)
      .addUniqueConstraint('risk_evaluations_trigger_unique', ['organization_id','event_id','trigger_key'])
      .execute()

    await db.schema.createIndex('risk_evaluations_event_idx')
      .on('risk_evaluations').columns(['organization_id','event_id','evaluated_at']).execute()

    await db.schema.createTable('event_risks')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('risk_key', 'varchar(220)', (col) => col.notNull())
      .addColumn('type', 'varchar(48)', (col) => col.notNull())
      .addColumn('severity', 'varchar(16)', (col) => col.notNull())
      .addColumn('score', 'integer', (col) => col.notNull())
      .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('open'))
      .addColumn('source_type', 'varchar(32)', (col) => col.notNull())
      .addColumn('source_id', 'uuid')
      .addColumn('title', 'varchar(240)', (col) => col.notNull())
      .addColumn('description', 'text', (col) => col.notNull())
      .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('first_detected_at', 'timestamptz', (col) => col.notNull())
      .addColumn('last_detected_at', 'timestamptz', (col) => col.notNull())
      .addColumn('acknowledged_at', 'timestamptz')
      .addColumn('acknowledged_by', 'varchar(128)')
      .addColumn('resolved_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('event_risks_type_check', sql`type in ('task_overdue','task_due_soon','vendor_unconfirmed','vendor_declined','vendor_schedule_review','dependency_unresolved','critical_inbox_item','recent_sensitive_change','change_dependency_pending')`)
      .addCheckConstraint('event_risks_severity_check', sql`severity in ('low','medium','high','critical')`)
      .addCheckConstraint('event_risks_score_check', sql`score between 0 and 100`)
      .addCheckConstraint('event_risks_status_check', sql`status in ('open','acknowledged','resolved')`)
      .addCheckConstraint('event_risks_source_type_check', sql`source_type in ('event','task','event_vendor','dependency_impact','inbox_item','change_proposal')`)
      .addUniqueConstraint('event_risks_key_unique', ['organization_id','event_id','risk_key'])
      .execute()

    await db.schema.createIndex('event_risks_event_status_idx')
      .on('event_risks').columns(['organization_id','event_id','status','score']).execute()
    await db.schema.createIndex('event_risks_workspace_idx')
      .on('event_risks').columns(['organization_id','status','severity','score']).execute()
    await db.schema.createIndex('event_risks_source_idx')
      .on('event_risks').columns(['organization_id','source_type','source_id']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('event_risks').ifExists().execute()
    await db.schema.dropTable('risk_evaluations').ifExists().execute()
  },
}
