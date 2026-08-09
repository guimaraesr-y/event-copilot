import { Migrator } from 'kysely/migration'
import { createDatabase } from './database.ts'
import { migration001Foundation } from './migrations/001_foundation.ts'
import { migration002EventPlanning } from './migrations/002_event_planning.ts'
import { migration003Vendors } from './migrations/003_vendors.ts'

const db = createDatabase()
const migrator = new Migrator({
  db,
  provider: {
    async getMigrations() {
      return {
        '001_foundation': migration001Foundation,
        '002_event_planning': migration002EventPlanning,
        '003_vendors': migration003Vendors,
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
