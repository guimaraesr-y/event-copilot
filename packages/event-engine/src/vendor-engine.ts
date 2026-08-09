import type {
  AttachVendorToEventInput, ConfirmVendorInput, CreateVendorInput, DeclineVendorInput, DomainEvent,
  EventVendor, RequestVendorConfirmationInput, UpdateEventVendorInput, Vendor, VendorStore,
} from '@ecc/domain'
import {
  DuplicateEventVendorError, EventVendorNotFoundError, VendorNotFoundError, VendorValidationError,
} from '@ecc/domain'

export interface VendorEngineDependencies {
  store: VendorStore
  now?: () => Date
  newId?: () => string
}

export class VendorEngine {
  private readonly store: VendorStore
  private readonly now: () => Date
  private readonly newId: () => string

  constructor({ store, now = () => new Date(), newId = () => crypto.randomUUID() }: VendorEngineDependencies) {
    this.store = store
    this.now = now
    this.newId = newId
  }

  async createVendor(input: CreateVendorInput): Promise<Vendor> {
    const name = input.name.trim()
    if (name.length < 2) throw new VendorValidationError('Vendor name must contain at least 2 characters')
    const now = this.now()
    const vendor: Vendor = {
      id: this.newId(), organizationId: input.organizationId, name, category: input.category,
      contactName: clean(input.contactName), phone: clean(input.phone), email: clean(input.email)?.toLowerCase() ?? null,
      notes: clean(input.notes), createdAt: now, updatedAt: now,
    }
    await this.store.createVendor(vendor)
    return vendor
  }

  getVendor(organizationId: string, vendorId: string): Promise<Vendor | null> {
    return this.store.findVendorById(organizationId, vendorId)
  }

  listVendors(organizationId: string): Promise<Vendor[]> {
    return this.store.listVendors(organizationId)
  }

  async attachVendorToEvent(input: AttachVendorToEventInput): Promise<EventVendor> {
    const event = await this.store.findEventById(input.organizationId, input.eventId)
    if (!event) throw new VendorValidationError('Event not found')
    const vendor = await this.store.findVendorById(input.organizationId, input.vendorId)
    if (!vendor) throw new VendorNotFoundError()
    if (await this.store.findEventVendorByVendorId(input.organizationId, input.eventId, input.vendorId)) {
      throw new DuplicateEventVendorError()
    }
    validateOperationalWindow(input.arrivalAt ?? null, input.departureAt ?? null)
    validateTeamSize(input.teamSize ?? null)
    const now = this.now()
    const eventVendor: EventVendor = {
      id: this.newId(), organizationId: input.organizationId, eventId: input.eventId, vendorId: vendor.id,
      vendorName: vendor.name, category: vendor.category,
      contactName: input.contactName !== undefined ? clean(input.contactName) : vendor.contactName,
      phone: input.phone !== undefined ? clean(input.phone) : vendor.phone,
      email: input.email !== undefined ? clean(input.email)?.toLowerCase() ?? null : vendor.email,
      confirmationStatus: 'pending', contractStatus: input.contractStatus ?? 'not_applicable',
      paymentStatus: input.paymentStatus ?? 'not_applicable', arrivalAt: input.arrivalAt ?? null,
      departureAt: input.departureAt ?? null, teamSize: input.teamSize ?? null, confirmationRequestedAt: null,
      confirmationDeadlineAt: null, confirmedAt: null, declinedAt: null, notes: clean(input.notes),
      createdAt: now, updatedAt: now,
    }
    await this.store.createEventVendorWithOutbox(eventVendor, this.domainEvent(eventVendor, 'vendor.attached', {
      eventVendorId: eventVendor.id, eventId: eventVendor.eventId, vendorId: eventVendor.vendorId,
      vendorName: eventVendor.vendorName, category: eventVendor.category,
    }))
    return eventVendor
  }

  listEventVendors(organizationId: string, eventId: string): Promise<EventVendor[]> {
    return this.store.listEventVendors(organizationId, eventId)
  }

  async updateEventVendor(input: UpdateEventVendorInput): Promise<EventVendor> {
    const current = await this.requireAssignment(input.organizationId, input.eventId, input.eventVendorId)
    const updated: EventVendor = {
      ...current,
      contactName: input.contactName !== undefined ? clean(input.contactName) : current.contactName,
      phone: input.phone !== undefined ? clean(input.phone) : current.phone,
      email: input.email !== undefined ? clean(input.email)?.toLowerCase() ?? null : current.email,
      arrivalAt: input.arrivalAt !== undefined ? input.arrivalAt : current.arrivalAt,
      departureAt: input.departureAt !== undefined ? input.departureAt : current.departureAt,
      teamSize: input.teamSize !== undefined ? input.teamSize : current.teamSize,
      contractStatus: input.contractStatus ?? current.contractStatus,
      paymentStatus: input.paymentStatus ?? current.paymentStatus,
      notes: input.notes !== undefined ? clean(input.notes) : current.notes,
      updatedAt: this.now(),
    }
    validateOperationalWindow(updated.arrivalAt, updated.departureAt)
    validateTeamSize(updated.teamSize)
    await this.store.updateEventVendorWithOutbox(updated, this.domainEvent(updated, 'vendor.assignment_updated', {
      eventVendorId: updated.id, eventId: updated.eventId, vendorId: updated.vendorId,
    }))
    return updated
  }

  async requestConfirmation(input: RequestVendorConfirmationInput): Promise<EventVendor> {
    const current = await this.requireAssignment(input.organizationId, input.eventId, input.eventVendorId)
    if (current.confirmationStatus === 'cancelled') throw new VendorValidationError('Cancelled vendor assignment cannot be confirmed')
    if (current.confirmationStatus === 'confirmed') throw new VendorValidationError('Vendor is already confirmed')
    const now = this.now()
    const updated: EventVendor = {
      ...current, confirmationStatus: 'requested', confirmationRequestedAt: now,
      confirmationDeadlineAt: input.deadlineAt ?? current.confirmationDeadlineAt,
      confirmedAt: null, declinedAt: null, updatedAt: now,
    }
    await this.store.updateEventVendorWithOutbox(updated, this.domainEvent(updated, 'vendor.confirmation_requested', {
      eventVendorId: updated.id, eventId: updated.eventId, vendorId: updated.vendorId,
      vendorName: updated.vendorName, phone: updated.phone, email: updated.email,
      deadlineAt: updated.confirmationDeadlineAt?.toISOString() ?? null,
    }))
    return updated
  }

  async confirm(input: ConfirmVendorInput): Promise<EventVendor> {
    const current = await this.requireAssignment(input.organizationId, input.eventId, input.eventVendorId)
    if (current.confirmationStatus === 'cancelled') throw new VendorValidationError('Cancelled vendor assignment cannot be confirmed')
    const now = this.now()
    const updated: EventVendor = {
      ...current, confirmationStatus: 'confirmed',
      arrivalAt: input.arrivalAt !== undefined ? input.arrivalAt : current.arrivalAt,
      departureAt: input.departureAt !== undefined ? input.departureAt : current.departureAt,
      teamSize: input.teamSize !== undefined ? input.teamSize : current.teamSize,
      notes: input.notes !== undefined ? clean(input.notes) : current.notes,
      confirmedAt: now, declinedAt: null, updatedAt: now,
    }
    validateOperationalWindow(updated.arrivalAt, updated.departureAt)
    validateTeamSize(updated.teamSize)
    await this.store.updateEventVendorWithOutbox(updated, this.domainEvent(updated, 'vendor.confirmed', {
      eventVendorId: updated.id, eventId: updated.eventId, vendorId: updated.vendorId,
      vendorName: updated.vendorName, arrivalAt: updated.arrivalAt?.toISOString() ?? null, teamSize: updated.teamSize,
    }))
    return updated
  }

  async decline(input: DeclineVendorInput): Promise<EventVendor> {
    const current = await this.requireAssignment(input.organizationId, input.eventId, input.eventVendorId)
    if (current.confirmationStatus === 'cancelled') throw new VendorValidationError('Cancelled vendor assignment cannot be declined')
    const now = this.now()
    const updated: EventVendor = {
      ...current, confirmationStatus: 'declined', confirmedAt: null, declinedAt: now,
      notes: input.notes !== undefined ? clean(input.notes) : current.notes, updatedAt: now,
    }
    await this.store.updateEventVendorWithOutbox(updated, this.domainEvent(updated, 'vendor.declined', {
      eventVendorId: updated.id, eventId: updated.eventId, vendorId: updated.vendorId, vendorName: updated.vendorName,
    }))
    return updated
  }

  private async requireAssignment(organizationId: string, eventId: string, eventVendorId: string): Promise<EventVendor> {
    const assignment = await this.store.findEventVendorById(organizationId, eventId, eventVendorId)
    if (!assignment) throw new EventVendorNotFoundError()
    return assignment
  }

  private domainEvent(eventVendor: EventVendor, eventType: string, payload: Record<string, unknown>): DomainEvent {
    return {
      id: this.newId(), organizationId: eventVendor.organizationId, eventType, aggregateType: 'event_vendor',
      aggregateId: eventVendor.id, occurredAt: this.now(), payload,
    }
  }
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}
function validateTeamSize(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 0)) throw new VendorValidationError('teamSize must be a non-negative integer')
}
function validateOperationalWindow(arrivalAt: Date | null, departureAt: Date | null): void {
  if (arrivalAt && Number.isNaN(arrivalAt.getTime())) throw new VendorValidationError('arrivalAt must be a valid date')
  if (departureAt && Number.isNaN(departureAt.getTime())) throw new VendorValidationError('departureAt must be a valid date')
  if (arrivalAt && departureAt && departureAt < arrivalAt) throw new VendorValidationError('departureAt cannot be earlier than arrivalAt')
}
