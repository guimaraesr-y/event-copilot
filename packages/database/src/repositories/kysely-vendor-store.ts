import type { Kysely, Transaction } from 'kysely'
import type { DomainEvent, Event, EventVendor, Vendor, VendorStore } from '@ecc/domain'
import type { DatabaseSchema } from '../db-types.ts'

export class KyselyVendorStore implements VendorStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async createVendor(vendor: Vendor): Promise<void> {
    await this.db.insertInto('vendors').values({
      id: vendor.id,
      organization_id: vendor.organizationId,
      name: vendor.name,
      category: vendor.category,
      contact_name: vendor.contactName,
      phone: vendor.phone,
      email: vendor.email,
      notes: vendor.notes,
      created_at: vendor.createdAt,
      updated_at: vendor.updatedAt,
    }).execute()
  }

  async findVendorById(organizationId: string, vendorId: string): Promise<Vendor | null> {
    const row = await this.db.selectFrom('vendors').selectAll()
      .where('organization_id', '=', organizationId).where('id', '=', vendorId).executeTakeFirst()
    return row ? this.mapVendor(row) : null
  }

  async listVendors(organizationId: string): Promise<Vendor[]> {
    const rows = await this.db.selectFrom('vendors').selectAll()
      .where('organization_id', '=', organizationId).orderBy('category', 'asc').orderBy('name', 'asc').execute()
    return rows.map((row) => this.mapVendor(row))
  }

  async findEventById(organizationId: string, eventId: string): Promise<Event | null> {
    const row = await this.db.selectFrom('events').selectAll()
      .where('organization_id', '=', organizationId).where('id', '=', eventId).executeTakeFirst()
    if (!row) return null
    return {
      id: row.id,
      organizationId: row.organization_id,
      templateId: row.template_id,
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

  async findEventVendorById(organizationId: string, eventId: string, eventVendorId: string): Promise<EventVendor | null> {
    const row = await this.db.selectFrom('event_vendors').selectAll()
      .where('organization_id', '=', organizationId).where('event_id', '=', eventId).where('id', '=', eventVendorId)
      .executeTakeFirst()
    return row ? this.mapEventVendor(row) : null
  }

  async findEventVendorByVendorId(organizationId: string, eventId: string, vendorId: string): Promise<EventVendor | null> {
    const row = await this.db.selectFrom('event_vendors').selectAll()
      .where('organization_id', '=', organizationId).where('event_id', '=', eventId).where('vendor_id', '=', vendorId)
      .executeTakeFirst()
    return row ? this.mapEventVendor(row) : null
  }

  async listEventVendors(organizationId: string, eventId: string): Promise<EventVendor[]> {
    const rows = await this.db.selectFrom('event_vendors').selectAll()
      .where('organization_id', '=', organizationId).where('event_id', '=', eventId)
      .orderBy('category', 'asc').orderBy('vendor_name', 'asc').execute()
    return rows.map((row) => this.mapEventVendor(row))
  }

  async createEventVendorWithOutbox(eventVendor: EventVendor, domainEvent: DomainEvent): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('event_vendors').values(this.eventVendorValues(eventVendor)).execute()
      await this.insertOutbox(trx, domainEvent)
    })
  }

  async updateEventVendorWithOutbox(eventVendor: EventVendor, domainEvent: DomainEvent): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('event_vendors').set({
        contact_name: eventVendor.contactName,
        phone: eventVendor.phone,
        email: eventVendor.email,
        confirmation_status: eventVendor.confirmationStatus,
        contract_status: eventVendor.contractStatus,
        payment_status: eventVendor.paymentStatus,
        arrival_at: eventVendor.arrivalAt,
        departure_at: eventVendor.departureAt,
        team_size: eventVendor.teamSize,
        confirmation_requested_at: eventVendor.confirmationRequestedAt,
        confirmation_deadline_at: eventVendor.confirmationDeadlineAt,
        confirmed_at: eventVendor.confirmedAt,
        declined_at: eventVendor.declinedAt,
        notes: eventVendor.notes,
        updated_at: eventVendor.updatedAt,
      }).where('organization_id', '=', eventVendor.organizationId)
        .where('event_id', '=', eventVendor.eventId).where('id', '=', eventVendor.id).execute()
      await this.insertOutbox(trx, domainEvent)
    })
  }

  private eventVendorValues(value: EventVendor) {
    return {
      id: value.id,
      organization_id: value.organizationId,
      event_id: value.eventId,
      vendor_id: value.vendorId,
      vendor_name: value.vendorName,
      category: value.category,
      contact_name: value.contactName,
      phone: value.phone,
      email: value.email,
      confirmation_status: value.confirmationStatus,
      contract_status: value.contractStatus,
      payment_status: value.paymentStatus,
      arrival_at: value.arrivalAt,
      departure_at: value.departureAt,
      team_size: value.teamSize,
      confirmation_requested_at: value.confirmationRequestedAt,
      confirmation_deadline_at: value.confirmationDeadlineAt,
      confirmed_at: value.confirmedAt,
      declined_at: value.declinedAt,
      notes: value.notes,
      created_at: value.createdAt,
      updated_at: value.updatedAt,
    }
  }

  private async insertOutbox(trx: Transaction<DatabaseSchema>, domainEvent: DomainEvent): Promise<void> {
    await trx.insertInto('outbox_events').values({
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
    }).execute()
  }

  private mapVendor(row: any): Vendor {
    return {
      id: row.id, organizationId: row.organization_id, name: row.name, category: row.category,
      contactName: row.contact_name, phone: row.phone, email: row.email, notes: row.notes,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private mapEventVendor(row: any): EventVendor {
    return {
      id: row.id, organizationId: row.organization_id, eventId: row.event_id, vendorId: row.vendor_id,
      vendorName: row.vendor_name, category: row.category, contactName: row.contact_name, phone: row.phone, email: row.email,
      confirmationStatus: row.confirmation_status, contractStatus: row.contract_status, paymentStatus: row.payment_status,
      arrivalAt: row.arrival_at, departureAt: row.departure_at, teamSize: row.team_size,
      confirmationRequestedAt: row.confirmation_requested_at, confirmationDeadlineAt: row.confirmation_deadline_at,
      confirmedAt: row.confirmed_at, declinedAt: row.declined_at, notes: row.notes,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
