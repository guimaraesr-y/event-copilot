import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration019DMinus1Brief = {
  async up(db:Kysely<DatabaseSchema>):Promise<void>{
    await db.schema.createTable('organization_brief_schedules')
      .addColumn('organization_id','uuid',c=>c.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('brief_type','varchar(24)',c=>c.notNull())
      .addColumn('enabled','boolean',c=>c.notNull().defaultTo(false))
      .addColumn('local_time','varchar(5)',c=>c.notNull())
      .addColumn('channel','varchar(24)',c=>c.notNull().defaultTo('whatsapp'))
      .addColumn('recipient','varchar(80)')
      .addColumn('updated_by_sender','varchar(160)')
      .addColumn('created_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at','timestamptz',c=>c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint('organization_brief_schedules_pk',['organization_id','brief_type'])
      .addCheckConstraint('organization_brief_schedules_type_check',sql`brief_type in ('daily','d_minus_1')`)
      .addCheckConstraint('organization_brief_schedules_time_check',sql`local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`)
      .addCheckConstraint('organization_brief_schedules_channel_check',sql`channel = 'whatsapp'`)
      .addCheckConstraint('organization_brief_schedules_enabled_recipient_check',sql`not enabled or recipient is not null`)
      .execute()

    await sql`
      insert into organization_brief_schedules (
        organization_id, brief_type, enabled, local_time, channel, recipient,
        updated_by_sender, created_at, updated_at
      )
      select organization_id, 'daily', enabled, local_time, channel, recipient,
             updated_by_sender, created_at, updated_at
      from organization_brief_preferences
      on conflict (organization_id, brief_type) do nothing
    `.execute(db)

    await db.schema.alterTable('daily_briefs')
      .addColumn('event_id','uuid',c=>c.references('events.id').onDelete('cascade'))
      .execute()

    await db.schema.alterTable('daily_briefs')
      .dropConstraint('daily_briefs_revision_unique')
      .execute()

    await db.schema.createIndex('daily_briefs_daily_revision_unique')
      .unique()
      .on('daily_briefs')
      .columns(['organization_id','brief_type','reference_date','revision'])
      .where(sql`event_id is null`)
      .execute()

    await db.schema.createIndex('daily_briefs_event_revision_unique')
      .unique()
      .on('daily_briefs')
      .columns(['organization_id','brief_type','event_id','reference_date','revision'])
      .where(sql`event_id is not null`)
      .execute()

    await db.schema.alterTable('daily_briefs')
      .addCheckConstraint('daily_briefs_event_scope_check',sql`(brief_type = 'daily' and event_id is null) or (brief_type = 'd_minus_1' and event_id is not null)`)
      .execute()
  },

  async down(db:Kysely<DatabaseSchema>):Promise<void>{
    await db.deleteFrom('daily_briefs').where('brief_type','=','d_minus_1').execute()
    await db.schema.alterTable('daily_briefs').dropConstraint('daily_briefs_event_scope_check').execute()
    await db.schema.dropIndex('daily_briefs_event_revision_unique').ifExists().execute()
    await db.schema.dropIndex('daily_briefs_daily_revision_unique').ifExists().execute()
    await db.schema.alterTable('daily_briefs').dropColumn('event_id').execute()
    await db.schema.alterTable('daily_briefs').addUniqueConstraint('daily_briefs_revision_unique',['organization_id','brief_type','reference_date','revision']).execute()
    await db.schema.dropTable('organization_brief_schedules').ifExists().execute()
  },
}
