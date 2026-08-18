import type { Kysely, Selectable, Transaction } from 'kysely'
import type {
  ChangeProposal,
  ChangeProposalImpact,
  ChangeProposalStore,
  ChangeProposalWithImpacts,
  DomainEvent,
  Event,
  ListChangeProposalsInput,
} from '@ecc/domain'
import type { ChangeProposalImpactsTable, ChangeProposalsTable, DatabaseSchema } from '../db-types.ts'

export class KyselyChangeProposalStore implements ChangeProposalStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async findById(organizationId: string, proposalId: string): Promise<ChangeProposalWithImpacts | null> {
    const row = await this.db.selectFrom('change_proposals').selectAll()
      .where('organization_id', '=', organizationId).where('id', '=', proposalId).executeTakeFirst()
    return row ? this.withImpacts(row) : null
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<ChangeProposalWithImpacts | null> {
    const row = await this.db.selectFrom('change_proposals').selectAll()
      .where('organization_id', '=', organizationId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst()
    return row ? this.withImpacts(row) : null
  }

  async list(input: ListChangeProposalsInput): Promise<ChangeProposalWithImpacts[]> {
    let query = this.db.selectFrom('change_proposals').selectAll().where('organization_id', '=', input.organizationId)
    if (input.eventId) query = query.where('event_id', '=', input.eventId)
    if (input.status) query = query.where('status', '=', input.status)
    if (input.requestedBySender) query = query.where('requested_by_sender', '=', input.requestedBySender)
    const rows = await query.orderBy('created_at', 'desc').limit(clamp(input.limit)).execute()
    return Promise.all(rows.map((row) => this.withImpacts(row)))
  }

  async createWithOutbox(proposal: ChangeProposal, impacts: ChangeProposalImpact[], domainEvent: DomainEvent): Promise<{ value: ChangeProposalWithImpacts; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto('change_proposals').values(proposalValues(proposal))
        .onConflict((oc) => oc.columns(['organization_id','idempotency_key']).doNothing())
        .returning('id').executeTakeFirst()
      if (!inserted) {
        const row = await trx.selectFrom('change_proposals').selectAll()
          .where('organization_id', '=', proposal.organizationId).where('idempotency_key', '=', proposal.idempotencyKey).executeTakeFirstOrThrow()
        return { value: await withImpactsTrx(trx, row), created: false }
      }
      if (impacts.length) await trx.insertInto('change_proposal_impacts').values(impacts.map(impactValues)).execute()
      await insertOutbox(trx, domainEvent)
      return { value: { proposal, impacts }, created: true }
    })
  }

  async applyWithOutbox(proposal: ChangeProposal, updatedEvent: Event, domainEvents: DomainEvent[]): Promise<{ value: ChangeProposalWithImpacts; applied: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.updateTable('change_proposals').set({
        status: proposal.status, decided_by_sender: proposal.decidedBySender, decided_at: proposal.decidedAt,
        applied_at: proposal.appliedAt, updated_at: proposal.updatedAt,
      }).where('organization_id', '=', proposal.organizationId).where('id', '=', proposal.id).where('status', '=', 'proposed')
        .returningAll().executeTakeFirst()
      if (!row) {
        const existing = await trx.selectFrom('change_proposals').selectAll().where('organization_id', '=', proposal.organizationId).where('id', '=', proposal.id).executeTakeFirstOrThrow()
        return { value: await withImpactsTrx(trx, existing), applied: false }
      }
      await trx.updateTable('events').set({
        start_at: updatedEvent.startAt, end_at: updatedEvent.endAt, guest_count: updatedEvent.guestCount,
        venue_name: updatedEvent.venueName, venue_address: updatedEvent.venueAddress, updated_at: updatedEvent.updatedAt,
      }).where('organization_id', '=', updatedEvent.organizationId).where('id', '=', updatedEvent.id).executeTakeFirstOrThrow()
      for (const event of domainEvents) await insertOutbox(trx, event)
      return { value: await withImpactsTrx(trx, row), applied: true }
    })
  }

  async rejectWithOutbox(proposal: ChangeProposal, domainEvent: DomainEvent): Promise<{ value: ChangeProposalWithImpacts; rejected: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.updateTable('change_proposals').set({
        status: proposal.status, decided_by_sender: proposal.decidedBySender, decided_at: proposal.decidedAt,
        reason: proposal.reason, updated_at: proposal.updatedAt,
      }).where('organization_id', '=', proposal.organizationId).where('id', '=', proposal.id).where('status', '=', 'proposed')
        .returningAll().executeTakeFirst()
      if (!row) {
        const existing = await trx.selectFrom('change_proposals').selectAll().where('organization_id', '=', proposal.organizationId).where('id', '=', proposal.id).executeTakeFirstOrThrow()
        return { value: await withImpactsTrx(trx, existing), rejected: false }
      }
      await insertOutbox(trx, domainEvent)
      return { value: await withImpactsTrx(trx, row), rejected: true }
    })
  }

  private async withImpacts(row: Selectable<ChangeProposalsTable>): Promise<ChangeProposalWithImpacts> {
    const impacts = await this.db.selectFrom('change_proposal_impacts').selectAll()
      .where('organization_id', '=', row.organization_id).where('proposal_id', '=', row.id).orderBy('created_at').execute()
    return { proposal: mapProposal(row), impacts: impacts.map(mapImpact) }
  }
}

async function withImpactsTrx(trx: Transaction<DatabaseSchema>, row: Selectable<ChangeProposalsTable>): Promise<ChangeProposalWithImpacts> {
  const impacts = await trx.selectFrom('change_proposal_impacts').selectAll().where('organization_id', '=', row.organization_id).where('proposal_id', '=', row.id).orderBy('created_at').execute()
  return { proposal: mapProposal(row), impacts: impacts.map(mapImpact) }
}
function proposalValues(p: ChangeProposal) { return { id: p.id, organization_id: p.organizationId, event_id: p.eventId, requested_by_sender: p.requestedBySender, decided_by_sender: p.decidedBySender, source_agent_turn_id: p.sourceAgentTurnId, idempotency_key: p.idempotencyKey, type: p.type, current_value: p.currentValue, proposed_value: p.proposedValue, reason: p.reason, status: p.status, created_at: p.createdAt, updated_at: p.updatedAt, decided_at: p.decidedAt, applied_at: p.appliedAt } }
function impactValues(i: ChangeProposalImpact) { return { id: i.id, organization_id: i.organizationId, proposal_id: i.proposalId, event_id: i.eventId, category: i.category, severity: i.severity, title: i.title, description: i.description, metadata: i.metadata, created_at: i.createdAt } }
function mapProposal(r: Selectable<ChangeProposalsTable>): ChangeProposal { return { id: r.id, organizationId: r.organization_id, eventId: r.event_id, requestedBySender: r.requested_by_sender, decidedBySender: r.decided_by_sender, sourceAgentTurnId: r.source_agent_turn_id, idempotencyKey: r.idempotency_key, type: r.type, currentValue: r.current_value, proposedValue: r.proposed_value, reason: r.reason, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at, appliedAt: r.applied_at } }
function mapImpact(r: Selectable<ChangeProposalImpactsTable>): ChangeProposalImpact { return { id: r.id, organizationId: r.organization_id, proposalId: r.proposal_id, eventId: r.event_id, category: r.category, severity: r.severity, title: r.title, description: r.description, metadata: r.metadata, createdAt: r.created_at } }
async function insertOutbox(trx: Transaction<DatabaseSchema>, event: DomainEvent): Promise<void> { await trx.insertInto('outbox_events').values({ id: event.id, organization_id: event.organizationId, event_type: event.eventType, aggregate_type: event.aggregateType, aggregate_id: event.aggregateId, payload: event.payload, occurred_at: event.occurredAt, available_at: event.occurredAt, claimed_at: null, claimed_by: null, dispatched_at: null, last_error: null }).execute() }
function clamp(value: number | undefined) { return !value || !Number.isInteger(value) || value < 1 ? 50 : Math.min(value, 200) }
