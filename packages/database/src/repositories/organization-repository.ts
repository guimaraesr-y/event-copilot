import type { Kysely } from 'kysely'
import type { Organization } from '@ecc/domain'
import type { DatabaseSchema } from '../db-types.ts'

export class OrganizationRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async create(name: string, timezone: string): Promise<Organization> {
    const now = new Date()
    const id = crypto.randomUUID()

    const row = await this.db
      .insertInto('organizations')
      .values({
        id,
        name: name.trim(),
        timezone,
        settings: {},
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return this.map(row)
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()
    return Boolean(row)
  }

  private map(row: {
    id: string
    name: string
    timezone: string
    settings: Record<string, unknown>
    created_at: Date
    updated_at: Date
  }): Organization {
    return {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      settings: row.settings,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
