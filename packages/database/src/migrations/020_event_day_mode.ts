import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration020EventDayMode = {
  async up(db:Kysely<DatabaseSchema>):Promise<void>{
    await db.schema.alterTable('event_vendors')
      .addColumn('actual_arrival_at','timestamptz')
      .addColumn('actual_departure_at','timestamptz')
      .execute()

    await db.schema.createTable('event_day_sessions')
      .addColumn('id','uuid',c=>c.primaryKey())
      .addColumn('organization_id','uuid',c=>c.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id','uuid',c=>c.notNull().references('events.id').onDelete('cascade'))
      .addColumn('status','varchar(24)',c=>c.notNull())
      .addColumn('started_at','timestamptz',c=>c.notNull())
      .addColumn('completed_at','timestamptz')
      .addColumn('started_by_sender','varchar(160)',c=>c.notNull())
      .addColumn('completed_by_sender','varchar(160)')
      .addColumn('created_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('event_day_sessions_event_unique',['organization_id','event_id'])
      .addCheckConstraint('event_day_sessions_status_check',sql`status in ('active','completed')`)
      .addCheckConstraint('event_day_sessions_completion_check',sql`(status='active' and completed_at is null and completed_by_sender is null) or (status='completed' and completed_at is not null and completed_by_sender is not null)`)
      .execute()

    await db.schema.createTable('event_day_activity')
      .addColumn('id','uuid',c=>c.primaryKey())
      .addColumn('organization_id','uuid',c=>c.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('event_id','uuid',c=>c.notNull().references('events.id').onDelete('cascade'))
      .addColumn('session_id','uuid',c=>c.notNull().references('event_day_sessions.id').onDelete('cascade'))
      .addColumn('event_vendor_id','uuid',c=>c.references('event_vendors.id').onDelete('set null'))
      .addColumn('type','varchar(40)',c=>c.notNull())
      .addColumn('occurred_at','timestamptz',c=>c.notNull())
      .addColumn('created_by_sender','varchar(160)',c=>c.notNull())
      .addColumn('note','text')
      .addColumn('created_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('event_day_activity_type_check',sql`type in ('event_day.started','vendor.arrived','vendor.departed','event_day.completed')`)
      .execute()

    await db.schema.createIndex('event_day_activity_event_time_idx')
      .on('event_day_activity').columns(['organization_id','event_id','occurred_at']).execute()
    await db.schema.createIndex('event_day_activity_vendor_time_idx')
      .on('event_day_activity').columns(['organization_id','event_vendor_id','occurred_at']).execute()
  },

  async down(db:Kysely<DatabaseSchema>):Promise<void>{
    await db.schema.dropTable('event_day_activity').ifExists().execute()
    await db.schema.dropTable('event_day_sessions').ifExists().execute()
    await db.schema.alterTable('event_vendors').dropColumn('actual_departure_at').dropColumn('actual_arrival_at').execute()
  },
}
