import { sql, type Kysely } from 'kysely'
import type { DatabaseSchema } from '../db-types.ts'

export const migration012OperationalAgentToolTraceJsonb = {
  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    // Feature 08.2 initially passed JS arrays directly through node-postgres.
    // pg treats JS arrays as PostgreSQL arrays, which could persist [] as {} in jsonb.
    // Repair already-created rows before enforcing the invariant.
    await sql`
      update agent_turns
      set tool_trace = '[]'::jsonb
      where jsonb_typeof(tool_trace) is distinct from 'array'
    `.execute(db)

    await db.schema
      .alterTable('agent_turns')
      .addCheckConstraint('agent_turns_tool_trace_array_check', sql`jsonb_typeof(tool_trace) = 'array'`)
      .execute()
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .alterTable('agent_turns')
      .dropConstraint('agent_turns_tool_trace_array_check')
      .execute()
  },
}
