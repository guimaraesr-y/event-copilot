import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration021EventDayOperations = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('event_day_settings')
      .addColumn('organization_id', 'uuid', (c) =>
        c.notNull().references('organizations.id').onDelete('cascade'),
      )
      .addColumn('event_id', 'uuid', (c) =>
        c.notNull().references('events.id').onDelete('cascade'),
      )
      .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('updated_by_sender', 'varchar(160)', (c) =>
        c.notNull().defaultTo('system'),
      )
      .addColumn('created_at', 'timestamptz', (c) =>
        c.notNull().defaultTo(sql`now()`),
      )
      .addColumn('updated_at', 'timestamptz', (c) =>
        c.notNull().defaultTo(sql`now()`),
      )
      .addPrimaryKeyConstraint('event_day_settings_pk', [
        'organization_id',
        'event_id',
      ])
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .addColumn('phase', 'varchar(24)', (c) =>
        c.notNull().defaultTo('planning'),
      )
      .addColumn('event_day_kind', 'varchar(24)')
      .execute()

    // Kysely 0.29.x constraint builders are terminal. Each constraint
    // therefore needs its own ALTER TABLE ... execute() call.
    await db.schema
      .alterTable('event_tasks')
      .addCheckConstraint(
        'event_tasks_phase_check',
        sql`phase in ('planning','event_day')`,
      )
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .addCheckConstraint(
        'event_tasks_event_day_kind_check',
        sql`event_day_kind is null or event_day_kind in ('checklist','operation','incident')`,
      )
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .addCheckConstraint(
        'event_tasks_event_day_shape_check',
        sql`(phase='planning' and event_day_kind is null) or (phase='event_day' and event_day_kind is not null)`,
      )
      .execute()

    await db.schema
      .createIndex('event_tasks_event_day_status_idx')
      .on('event_tasks')
      .columns([
        'organization_id',
        'event_id',
        'phase',
        'status',
        'due_at',
      ])
      .execute()

    await db.schema
      .alterTable('event_day_sessions')
      .addColumn('previous_event_status', 'varchar(24)')
      .addColumn('completion_reason', 'varchar(24)')
      .execute()

    // Feature 16 had one session per event and completed the whole event. Existing
    // rows predate previous_event_status, so planning is the safest reversible
    // lifecycle fallback for those historical local/dev rows.
    await sql`
      update event_day_sessions
      set previous_event_status='planning'
      where previous_event_status is null
    `.execute(db)

    await sql`
      update event_day_sessions
      set completion_reason='manual'
      where status='completed'
        and completion_reason is null
    `.execute(db)

    await sql`
      alter table event_day_sessions
      alter column previous_event_status set not null
    `.execute(db)

    await db.schema
      .alterTable('event_day_sessions')
      .addCheckConstraint(
        'event_day_sessions_previous_status_check',
        sql`previous_event_status in ('draft','planning','confirmation','ready')`,
      )
      .execute()

    await db.schema
      .alterTable('event_day_sessions')
      .addCheckConstraint(
        'event_day_sessions_completion_reason_check',
        sql`completion_reason is null or completion_reason in ('manual','disabled')`,
      )
      .execute()

    // Event Day can be stopped and later re-enabled. Preserve session history and
    // enforce only one active session per event.
    await sql`
      alter table event_day_sessions
      drop constraint if exists event_day_sessions_event_unique
    `.execute(db)

    await sql`
      create unique index event_day_sessions_one_active_idx
      on event_day_sessions (organization_id,event_id)
      where status='active'
    `.execute(db)

    await db.schema
      .createIndex('event_day_sessions_event_started_idx')
      .on('event_day_sessions')
      .columns(['organization_id', 'event_id', 'started_at'])
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .dropIndex('event_day_sessions_event_started_idx')
      .ifExists()
      .execute()

    await sql`
      drop index if exists event_day_sessions_one_active_idx
    `.execute(db)

    // A downgrade can only restore the old uniqueness when at most one historical
    // session exists per event. This is intentionally a development rollback path.
    await sql`
      delete from event_day_sessions a
      using event_day_sessions b
      where a.organization_id=b.organization_id
        and a.event_id=b.event_id
        and a.started_at < b.started_at
    `.execute(db)

    await db.schema
      .alterTable('event_day_sessions')
      .addUniqueConstraint('event_day_sessions_event_unique', [
        'organization_id',
        'event_id',
      ])
      .execute()

    await db.schema
      .alterTable('event_day_sessions')
      .dropConstraint('event_day_sessions_completion_reason_check')
      .execute()

    await db.schema
      .alterTable('event_day_sessions')
      .dropConstraint('event_day_sessions_previous_status_check')
      .execute()

    await db.schema
      .alterTable('event_day_sessions')
      .dropColumn('completion_reason')
      .dropColumn('previous_event_status')
      .execute()

    await db.schema
      .dropIndex('event_tasks_event_day_status_idx')
      .ifExists()
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .dropConstraint('event_tasks_event_day_shape_check')
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .dropConstraint('event_tasks_event_day_kind_check')
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .dropConstraint('event_tasks_phase_check')
      .execute()

    await db.schema
      .alterTable('event_tasks')
      .dropColumn('event_day_kind')
      .dropColumn('phase')
      .execute()

    await db.schema
      .dropTable('event_day_settings')
      .ifExists()
      .execute()
  },
}