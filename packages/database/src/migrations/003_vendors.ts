import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration003Vendors = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('vendors')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('name', 'varchar(160)', (col) => col.notNull())
      .addColumn('category', 'varchar(32)', (col) => col.notNull())
      .addColumn('contact_name', 'varchar(160)')
      .addColumn('phone', 'varchar(40)')
      .addColumn('email', 'varchar(320)')
      .addColumn('notes', 'varchar(2000)')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('vendors_id_org_unique', ['id', 'organization_id'])
      .addCheckConstraint('vendors_category_check', sql`category in ('buffet','photo','video','decoration','dj','band','cake','sweets','venue','transport','celebrant','security','other')`)
      .execute()

    await db.schema.createIndex('vendors_org_category_name_idx').on('vendors').columns(['organization_id','category','name']).execute()

    await db.schema
      .createTable('event_vendors')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('organization_id', 'uuid', (col) => col.notNull())
      .addColumn('event_id', 'uuid', (col) => col.notNull())
      .addColumn('vendor_id', 'uuid', (col) => col.notNull())
      .addColumn('vendor_name', 'varchar(160)', (col) => col.notNull())
      .addColumn('category', 'varchar(32)', (col) => col.notNull())
      .addColumn('contact_name', 'varchar(160)')
      .addColumn('phone', 'varchar(40)')
      .addColumn('email', 'varchar(320)')
      .addColumn('confirmation_status', 'varchar(24)', (col) => col.notNull().defaultTo('pending'))
      .addColumn('contract_status', 'varchar(24)', (col) => col.notNull().defaultTo('not_applicable'))
      .addColumn('payment_status', 'varchar(24)', (col) => col.notNull().defaultTo('not_applicable'))
      .addColumn('arrival_at', 'timestamptz')
      .addColumn('departure_at', 'timestamptz')
      .addColumn('team_size', 'integer')
      .addColumn('confirmation_requested_at', 'timestamptz')
      .addColumn('confirmation_deadline_at', 'timestamptz')
      .addColumn('confirmed_at', 'timestamptz')
      .addColumn('declined_at', 'timestamptz')
      .addColumn('notes', 'varchar(2000)')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addForeignKeyConstraint('event_vendors_event_tenant_fk', ['event_id','organization_id'], 'events', ['id','organization_id'], (constraint) => constraint.onDelete('cascade'))
      .addForeignKeyConstraint('event_vendors_vendor_tenant_fk', ['vendor_id','organization_id'], 'vendors', ['id','organization_id'], (constraint) => constraint.onDelete('restrict'))
      .addUniqueConstraint('event_vendors_event_vendor_unique', ['organization_id','event_id','vendor_id'])
      .addCheckConstraint('event_vendors_category_check', sql`category in ('buffet','photo','video','decoration','dj','band','cake','sweets','venue','transport','celebrant','security','other')`)
      .addCheckConstraint('event_vendors_confirmation_status_check', sql`confirmation_status in ('pending','requested','confirmed','declined','cancelled')`)
      .addCheckConstraint('event_vendors_contract_status_check', sql`contract_status in ('not_applicable','pending','signed')`)
      .addCheckConstraint('event_vendors_payment_status_check', sql`payment_status in ('not_applicable','pending','partial','paid','overdue')`)
      .addCheckConstraint('event_vendors_team_size_check', sql`team_size is null or team_size >= 0`)
      .addCheckConstraint('event_vendors_times_check', sql`departure_at is null or arrival_at is null or departure_at >= arrival_at`)
      .execute()

    await db.schema.createIndex('event_vendors_event_status_idx').on('event_vendors').columns(['organization_id','event_id','confirmation_status']).execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('event_vendors').ifExists().execute()
    await db.schema.dropTable('vendors').ifExists().execute()
  },
}
