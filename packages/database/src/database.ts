import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { DatabaseSchema } from './db-types.ts'

const { Pool } = pg

export function createDatabase(databaseUrl = process.env.DATABASE_URL): Kysely<DatabaseSchema> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        max: 10,
      }),
    }),
  })
}

export async function checkDatabase(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`select 1`.execute(db)
}
