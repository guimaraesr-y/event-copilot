import type { Kysely, Transaction } from 'kysely'
import type { DomainEvent, Event, EventStore } from '@ecc/domain'
import type { DatabaseSchema } from '../db-types.ts'

export class KyselyEventStore implements EventStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async createEventWithOutbox(event: Event, domainEvent: DomainEvent): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.insertEvent(trx, event)
      await trx
        .insertInto('outbox_events')
        .values({
          id: domainEvent.id,
          organization_id: domainEvent.organizationId,
          event_type: domainEvent.eventType,
          aggregate_type: domainEvent.aggregateType,
          aggregate_id: domainEvent.aggregateId,
          payload: domainEvent.payload,
          occurred_at: domainEvent.occurredAt,
          available_at: domainEvent.occurredAt,
          claimed_at: null,
          claimed_by: null,
          dispatched_at: null,
          last_error: null,
        })
        .execute()
    })
  }

  async findEventById(organizationId: string, eventId: string): Promise<Event | null> {
    const row = await this.db
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', eventId)
      .executeTakeFirst()
    return row ? this.map(row) : null
  }

  async listEvents(organizationId: string): Promise<Event[]> {
    const rows = await this.db
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('start_at', 'asc')
      .execute()
    return rows.map((row) => this.map(row))
  }

  private async insertEvent(trx: Transaction<DatabaseSchema>, event: Event): Promise<void> {
    await trx
      .insertInto('events')
      .values({
        id: event.id,
        organization_id: event.organizationId,
        name: event.name,
        type: event.type,
        start_at: event.startAt,
        end_at: event.endAt,
        venue_name: event.venueName,
        venue_address: event.venueAddress,
        guest_count: event.guestCount,
        status: event.status,
        health_score: event.healthScore,
        owner_user_id: event.ownerUserId,
        created_at: event.createdAt,
        updated_at: event.updatedAt,
      })
      .execute()
  }

  private map(row: {
    id: string
    organization_id: string
    name: string
    type: Event['type']
    start_at: Date
    end_at: Date | null
    venue_name: string | null
    venue_address: string | null
    guest_count: number
    status: Event['status']
    health_score: number
    owner_user_id: string | null
    created_at: Date
    updated_at: Date
  }): Event {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      type: row.type,
      startAt: row.start_at,
      endAt: row.end_at,
      venueName: row.venue_name,
      venueAddress: row.venue_address,
      guestCount: row.guest_count,
      status: row.status,
      healthScore: row.health_score,
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
