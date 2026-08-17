import type { Kysely, Selectable } from 'kysely'
import type { AgentTurn, AgentTurnStore, CreateAgentTurnInput, UpdateAgentTurnInput } from '@ecc/domain'
import type { AgentTurnsTable, DatabaseSchema } from '../db-types.ts'
import { normalizeAgentToolTrace, serializeAgentToolTrace } from './agent-turn-json.ts'

export class KyselyAgentStore implements AgentTurnStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async createTurnIfAbsent(input: CreateAgentTurnInput): Promise<{ turn: AgentTurn; created: boolean }> {
    const inserted = await this.db.insertInto('agent_turns').values({
      id: input.id,
      organization_id: input.organizationId,
      sender: input.sender,
      idempotency_key: input.idempotencyKey,
      user_text: input.userText,
      explicit_event_id: input.explicitEventId ?? null,
      assistant_text: null,
      status: 'received',
      provider: input.provider,
      model: input.model,
      model_calls: 0,
      // node-postgres serializes JS arrays as PostgreSQL arrays. For a jsonb column that
      // can turn [] into the JSON object {}. Send JSON text explicitly instead.
      tool_trace: serializeAgentToolTrace([]),
      created_at: input.now,
      updated_at: input.now,
      completed_at: null,
      last_error: null,
    }).onConflict((oc) => oc.columns(['organization_id','idempotency_key']).doNothing())
      .returningAll().executeTakeFirst()

    if (inserted) return { turn: mapTurn(inserted), created: true }
    const existing = await this.db.selectFrom('agent_turns').selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow()
    return { turn: mapTurn(existing), created: false }
  }

  async updateTurn(organizationId: string, turnId: string, input: UpdateAgentTurnInput): Promise<AgentTurn> {
    const patch: Record<string, unknown> = { updated_at: input.updatedAt }
    if ('assistantText' in input) patch.assistant_text = input.assistantText ?? null
    if (input.status !== undefined) patch.status = input.status
    if (input.modelCalls !== undefined) patch.model_calls = input.modelCalls
    if (input.toolTrace !== undefined) patch.tool_trace = serializeAgentToolTrace(input.toolTrace)
    if ('completedAt' in input) patch.completed_at = input.completedAt ?? null
    if ('lastError' in input) patch.last_error = input.lastError ?? null

    const row = await this.db.updateTable('agent_turns').set(patch as any)
      .where('organization_id', '=', organizationId).where('id', '=', turnId)
      .returningAll().executeTakeFirstOrThrow()
    return mapTurn(row)
  }

  async listRecentTurns(organizationId: string, sender: string, limit: number): Promise<AgentTurn[]> {
    const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 8, 20))
    const rows = await this.db.selectFrom('agent_turns').selectAll()
      .where('organization_id', '=', organizationId)
      .where('sender', '=', sender)
      .where('status', '=', 'completed')
      .orderBy('created_at', 'desc')
      .limit(safeLimit)
      .execute()
    return rows.reverse().map(mapTurn)
  }
}

function mapTurn(row: Selectable<AgentTurnsTable>): AgentTurn {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sender: row.sender,
    idempotencyKey: row.idempotency_key,
    userText: row.user_text,
    explicitEventId: row.explicit_event_id,
    assistantText: row.assistant_text,
    status: row.status,
    provider: row.provider,
    model: row.model,
    modelCalls: row.model_calls,
    // Be tolerant of rows written by Feature 08.2 before the JSONB-array fix. Those
    // rows may contain {} instead of [] and must not crash the agent/history path.
    toolTrace: normalizeAgentToolTrace(row.tool_trace),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  }
}
