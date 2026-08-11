import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

/**
 * Compatibility migration for installations that already ran an earlier
 * revision of Mini-feature 05.1.
 *
 * NOT VALID preserves any historical rows created by a previously supported
 * provider while still enforcing the current provider set for new writes.
 */
export const migration007RestrictMessagingProviders = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await sql`alter table outbound_messages drop constraint if exists outbound_messages_provider_check`.execute(db)
    await sql`alter table outbound_messages add constraint outbound_messages_provider_check check (provider in ('mock','meta')) not valid`.execute(db)

    await sql`alter table messaging_webhook_events drop constraint if exists messaging_webhook_events_provider_check`.execute(db)
    await sql`alter table messaging_webhook_events add constraint messaging_webhook_events_provider_check check (provider in ('mock','meta')) not valid`.execute(db)
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    // Provider removal is intentionally irreversible at the application boundary.
    // Keep the current constraints on rollback rather than re-enabling old providers.
    await sql`alter table outbound_messages drop constraint if exists outbound_messages_provider_check`.execute(db)
    await sql`alter table outbound_messages add constraint outbound_messages_provider_check check (provider in ('mock','meta')) not valid`.execute(db)

    await sql`alter table messaging_webhook_events drop constraint if exists messaging_webhook_events_provider_check`.execute(db)
    await sql`alter table messaging_webhook_events add constraint messaging_webhook_events_provider_check check (provider in ('mock','meta')) not valid`.execute(db)
  },
}
