import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration017HealthScore = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.createTable('event_health_evaluations')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
      .addColumn('trigger_type', 'varchar(24)', (col) => col.notNull())
      .addColumn('trigger_key', 'varchar(220)', (col) => col.notNull())
      .addColumn('previous_score', 'integer', (col) => col.notNull())
      .addColumn('score', 'integer', (col) => col.notNull())
      .addColumn('delta', 'integer', (col) => col.notNull())
      .addColumn('status', 'varchar(20)', (col) => col.notNull())
      .addColumn('breakdown', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('evaluated_at', 'timestamptz', (col) => col.notNull())
      .addCheckConstraint('event_health_trigger_type_check', sql`trigger_type in ('risk_evaluation','manual')`)
      .addCheckConstraint('event_health_previous_score_check', sql`previous_score between 0 and 100`)
      .addCheckConstraint('event_health_score_check', sql`score between 0 and 100`)
      .addCheckConstraint('event_health_status_check', sql`status in ('excellent','good','attention','critical')`)
      .addCheckConstraint('event_health_breakdown_object_check', sql`jsonb_typeof(breakdown) = 'object'`)
      .addUniqueConstraint('event_health_evaluations_trigger_unique', ['organization_id','event_id','trigger_key'])
      .execute()

    await db.schema.createIndex('event_health_evaluations_event_idx')
      .on('event_health_evaluations').columns(['organization_id','event_id','evaluated_at']).execute()
    await db.schema.createIndex('event_health_evaluations_workspace_idx')
      .on('event_health_evaluations').columns(['organization_id','score','evaluated_at']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('event_health_evaluations').ifExists().execute()
  },
}
