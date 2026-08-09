import { Migrator } from 'kysely/migration'
import { createDatabase } from './database.ts'
import { migration001Foundation } from './migrations/001_foundation.ts'

const db = createDatabase()
const migrator = new Migrator({
  db,
  provider: {
    async getMigrations() {
      return {
        '001_foundation': migration001Foundation,
      }
    },
  },
})

const { error, results } = await migrator.migrateToLatest()

for (const result of results ?? []) {
  console.log(`[migration] ${result.migrationName}: ${result.status}`)
}

await db.destroy()

if (error) {
  console.error('[migration] failed', error)
  process.exit(1)
}
