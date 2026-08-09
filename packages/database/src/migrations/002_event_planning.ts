import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration002EventPlanning = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('event_templates')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(120)', (col) => col.notNull())
      .addColumn('event_type', 'varchar(32)', (col) => col.notNull())
      .addColumn('description', 'varchar(1000)')
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint(
        'event_templates_type_check',
        sql`event_type in ('wedding', 'birthday', 'corporate', 'other')`,
      )
      .addUniqueConstraint('event_templates_org_name_unique', ['organization_id', 'name'])
      .addUniqueConstraint('event_templates_id_org_unique', ['id', 'organization_id'])
      .execute()

    await db.schema
      .alterTable('events')
      .addUniqueConstraint('events_id_org_unique', ['id', 'organization_id'])
      .execute()

    await db.schema.alterTable('events').addColumn('template_id', 'uuid').execute()

    await db.schema
      .alterTable('events')
      .addForeignKeyConstraint(
        'events_template_tenant_fk',
        ['template_id', 'organization_id'],
        'event_templates',
        ['id', 'organization_id'],
      )
      .onDelete('restrict')
      .execute()

    await db.schema
      .createTable('event_template_tasks')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull())
      .addColumn('template_id', 'uuid', (col) => col.notNull())
      .addColumn('title', 'varchar(200)', (col) => col.notNull())
      .addColumn('description', 'varchar(2000)')
      .addColumn('offset_days', 'integer', (col) => col.notNull())
      .addColumn('due_time', 'varchar(5)', (col) => col.notNull().defaultTo('09:00'))
      .addColumn('priority', 'varchar(16)', (col) => col.notNull().defaultTo('normal'))
      .addColumn('type', 'varchar(32)', (col) => col.notNull().defaultTo('general'))
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addForeignKeyConstraint(
        'event_template_tasks_template_tenant_fk',
        ['template_id', 'organization_id'],
        'event_templates',
        ['id', 'organization_id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .addCheckConstraint('event_template_tasks_offset_check', sql`offset_days between -3650 and 3650`)
      .addCheckConstraint('event_template_tasks_due_time_check', sql`due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`)
      .addCheckConstraint(
        'event_template_tasks_priority_check',
        sql`priority in ('low', 'normal', 'high', 'critical')`,
      )
      .addCheckConstraint(
        'event_template_tasks_type_check',
        sql`type in ('general', 'confirmation', 'document', 'payment', 'guest', 'briefing', 'other')`,
      )
      .execute()

    await db.schema
      .createIndex('event_template_tasks_template_sort_idx')
      .on('event_template_tasks')
      .columns(['organization_id', 'template_id', 'sort_order'])
      .execute()

    await db.schema
      .createTable('event_template_milestones')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull())
      .addColumn('template_id', 'uuid', (col) => col.notNull())
      .addColumn('name', 'varchar(200)', (col) => col.notNull())
      .addColumn('description', 'varchar(2000)')
      .addColumn('offset_days', 'integer', (col) => col.notNull())
      .addColumn('due_time', 'varchar(5)', (col) => col.notNull().defaultTo('09:00'))
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addForeignKeyConstraint(
        'event_template_milestones_template_tenant_fk',
        ['template_id', 'organization_id'],
        'event_templates',
        ['id', 'organization_id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .addCheckConstraint('event_template_milestones_offset_check', sql`offset_days between -3650 and 3650`)
      .addCheckConstraint('event_template_milestones_due_time_check', sql`due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`)
      .execute()

    await db.schema
      .createIndex('event_template_milestones_template_sort_idx')
      .on('event_template_milestones')
      .columns(['organization_id', 'template_id', 'sort_order'])
      .execute()

    await db.schema
      .createTable('event_tasks')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull())
      .addColumn('event_id', 'uuid', (col) => col.notNull())
      .addColumn('template_task_id', 'uuid')
      .addColumn('title', 'varchar(200)', (col) => col.notNull())
      .addColumn('description', 'varchar(2000)')
      .addColumn('type', 'varchar(32)', (col) => col.notNull().defaultTo('general'))
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('pending'))
      .addColumn('priority', 'varchar(16)', (col) => col.notNull().defaultTo('normal'))
      .addColumn('due_at', 'timestamptz', (col) => col.notNull())
      .addColumn('source', 'varchar(24)', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('completed_at', 'timestamptz')
      .addForeignKeyConstraint(
        'event_tasks_event_tenant_fk',
        ['event_id', 'organization_id'],
        'events',
        ['id', 'organization_id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .addForeignKeyConstraint(
        'event_tasks_template_task_fk',
        ['template_task_id'],
        'event_template_tasks',
        ['id'],
        (constraint) => constraint.onDelete('set null'),
      )
      .addCheckConstraint(
        'event_tasks_type_check',
        sql`type in ('general', 'confirmation', 'document', 'payment', 'guest', 'briefing', 'other')`,
      )
      .addCheckConstraint(
        'event_tasks_status_check',
        sql`status in ('pending', 'in_progress', 'completed', 'cancelled')`,
      )
      .addCheckConstraint('event_tasks_priority_check', sql`priority in ('low', 'normal', 'high', 'critical')`)
      .addCheckConstraint(
        'event_tasks_source_check',
        sql`source in ('manual', 'template', 'automation', 'dependency', 'ai')`,
      )
      .execute()

    await db.schema
      .createIndex('event_tasks_event_due_idx')
      .on('event_tasks')
      .columns(['organization_id', 'event_id', 'due_at'])
      .execute()

    await db.schema
      .createTable('event_milestones')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull())
      .addColumn('event_id', 'uuid', (col) => col.notNull())
      .addColumn('template_milestone_id', 'uuid')
      .addColumn('name', 'varchar(200)', (col) => col.notNull())
      .addColumn('description', 'varchar(2000)')
      .addColumn('due_at', 'timestamptz', (col) => col.notNull())
      .addColumn('status', 'varchar(24)', (col) => col.notNull().defaultTo('pending'))
      .addColumn('source', 'varchar(24)', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('completed_at', 'timestamptz')
      .addForeignKeyConstraint(
        'event_milestones_event_tenant_fk',
        ['event_id', 'organization_id'],
        'events',
        ['id', 'organization_id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .addForeignKeyConstraint(
        'event_milestones_template_milestone_fk',
        ['template_milestone_id'],
        'event_template_milestones',
        ['id'],
        (constraint) => constraint.onDelete('set null'),
      )
      .addCheckConstraint(
        'event_milestones_status_check',
        sql`status in ('pending', 'reached', 'missed', 'cancelled')`,
      )
      .addCheckConstraint('event_milestones_source_check', sql`source in ('manual', 'template', 'automation')`)
      .execute()

    await db.schema
      .createIndex('event_milestones_event_due_idx')
      .on('event_milestones')
      .columns(['organization_id', 'event_id', 'due_at'])
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('event_milestones').ifExists().execute()
    await db.schema.dropTable('event_tasks').ifExists().execute()
    await db.schema.dropTable('event_template_milestones').ifExists().execute()
    await db.schema.dropTable('event_template_tasks').ifExists().execute()
    await db.schema.alterTable('events').dropConstraint('events_template_tenant_fk').execute()
    await db.schema.alterTable('events').dropColumn('template_id').execute()
    await db.schema.alterTable('events').dropConstraint('events_id_org_unique').execute()
    await db.schema.dropTable('event_templates').ifExists().execute()
  },
}
