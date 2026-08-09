import type { Kysely } from 'kysely'
import type { OutboxMessage } from '@ecc/domain'
import type { DatabaseSchema } from '../db-types.ts'

const CLAIM_TIMEOUT_MS = 60_000

export class OutboxRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async claimBatch(workerId: string, limit: number): Promise<OutboxMessage[]> {
    const now = new Date()
    const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS)

    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('outbox_events')
        .selectAll()
        .where('dispatched_at', 'is', null)
        .where('available_at', '<=', now)
        .where((eb) => eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', staleBefore)]))
        .orderBy('created_at', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute()

      if (rows.length === 0) return []

      const ids = rows.map((row) => row.id)
      await trx
        .updateTable('outbox_events')
        .set({ claimed_at: now, claimed_by: workerId })
        .where('id', 'in', ids)
        .execute()

      return rows.map((row) => this.map({ ...row, claimed_at: now, claimed_by: workerId }))
    })
  }

  async markDispatched(id: string, workerId: string): Promise<void> {
    await this.db
      .updateTable('outbox_events')
      .set({
        dispatched_at: new Date(),
        claimed_at: null,
        claimed_by: null,
        last_error: null,
      })
      .where('id', '=', id)
      .where('claimed_by', '=', workerId)
      .execute()
  }

  async markFailed(id: string, workerId: string, attempts: number, error: unknown): Promise<void> {
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
    await this.db
      .updateTable('outbox_events')
      .set({
        attempts,
        available_at: new Date(Date.now() + delayMs),
        claimed_at: null,
        claimed_by: null,
        last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      })
      .where('id', '=', id)
      .where('claimed_by', '=', workerId)
      .execute()
  }

  private map(row: {
    id: string
    organization_id: string
    event_type: string
    aggregate_type: string
    aggregate_id: string
    payload: Record<string, unknown>
    occurred_at: Date
    attempts: number
    available_at: Date
    claimed_at: Date | null
    claimed_by: string | null
    dispatched_at: Date | null
    last_error: string | null
  }): OutboxMessage {
    return {
      id: row.id,
      organizationId: row.organization_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: row.occurred_at,
      payload: row.payload,
      attempts: row.attempts,
      availableAt: row.available_at,
      claimedAt: row.claimed_at,
      claimedBy: row.claimed_by,
      dispatchedAt: row.dispatched_at,
      lastError: row.last_error,
    }
  }
}
