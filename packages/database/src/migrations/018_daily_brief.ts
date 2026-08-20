import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration018DailyBrief = {
  async up(db:Kysely<DatabaseSchema>):Promise<void>{
    await db.schema.createTable('organization_brief_preferences')
      .addColumn('organization_id','uuid',c=>c.primaryKey().references('organizations.id').onDelete('cascade'))
      .addColumn('enabled','boolean',c=>c.notNull().defaultTo(false))
      .addColumn('local_time','varchar(5)',c=>c.notNull().defaultTo('08:00'))
      .addColumn('channel','varchar(24)',c=>c.notNull().defaultTo('whatsapp'))
      .addColumn('recipient','varchar(80)')
      .addColumn('updated_by_sender','varchar(160)')
      .addColumn('created_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('organization_brief_preferences_time_check',sql`local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`)
      .addCheckConstraint('organization_brief_preferences_channel_check',sql`channel = 'whatsapp'`)
      .addCheckConstraint('organization_brief_preferences_enabled_recipient_check',sql`not enabled or recipient is not null`)
      .execute()

    await db.schema.createTable('daily_briefs')
      .addColumn('id','uuid',c=>c.primaryKey())
      .addColumn('organization_id','uuid',c=>c.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('brief_type','varchar(24)',c=>c.notNull().defaultTo('daily'))
      .addColumn('reference_date','date',c=>c.notNull())
      .addColumn('revision','integer',c=>c.notNull())
      .addColumn('status','varchar(24)',c=>c.notNull().defaultTo('generated'))
      .addColumn('trigger_type','varchar(24)',c=>c.notNull())
      .addColumn('trigger_key','varchar(180)',c=>c.notNull())
      .addColumn('summary','jsonb',c=>c.notNull())
      .addColumn('rendered_text','text',c=>c.notNull())
      .addColumn('generated_by_sender','varchar(160)')
      .addColumn('generated_at','timestamptz',c=>c.notNull())
      .addColumn('superseded_at','timestamptz')
      .addColumn('delivery_requested_at','timestamptz')
      .addUniqueConstraint('daily_briefs_trigger_unique',['organization_id','trigger_key'])
      .addUniqueConstraint('daily_briefs_revision_unique',['organization_id','brief_type','reference_date','revision'])
      .addCheckConstraint('daily_briefs_type_check',sql`brief_type in ('daily','d_minus_1')`)
      .addCheckConstraint('daily_briefs_status_check',sql`status in ('generated','superseded')`)
      .addCheckConstraint('daily_briefs_trigger_type_check',sql`trigger_type in ('scheduled','manual','agent')`)
      .addCheckConstraint('daily_briefs_revision_check',sql`revision > 0`)
      .addCheckConstraint('daily_briefs_summary_object_check',sql`jsonb_typeof(summary) = 'object'`)
      .execute()
    await db.schema.createIndex('daily_briefs_org_date_idx').on('daily_briefs').columns(['organization_id','reference_date','generated_at']).execute()
  },
  async down(db:Kysely<DatabaseSchema>):Promise<void>{
    await db.schema.dropTable('daily_briefs').ifExists().execute()
    await db.schema.dropTable('organization_brief_preferences').ifExists().execute()
  },
}
