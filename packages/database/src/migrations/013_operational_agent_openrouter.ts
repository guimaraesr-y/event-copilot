import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration013OperationalAgentOpenRouter = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .alterTable('agent_turns')
      .dropConstraint('agent_turns_provider_check')
      .execute()

    await db.schema
      .alterTable('agent_turns')
      .addCheckConstraint('agent_turns_provider_check', sql`provider in ('ollama','openrouter','openai','gemini','deterministic')`)
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .alterTable('agent_turns')
      .dropConstraint('agent_turns_provider_check')
      .execute()

    await db.schema
      .alterTable('agent_turns')
      .addCheckConstraint('agent_turns_provider_check', sql`provider in ('ollama','openai','gemini','deterministic')`)
      .execute()
  },
}
