import {
  EventValidationError,
  type CreateEventInput,
  type DomainEvent,
  type Event,
  type EventStore,
} from '@ecc/domain'

export interface EventEngineDependencies {
  store: EventStore
  now?: () => Date
  newId?: () => string
}

export class EventEngine {
  private readonly store: EventStore
  private readonly now: () => Date
  private readonly newId: () => string

  constructor({ store, now = () => new Date(), newId = () => crypto.randomUUID() }: EventEngineDependencies) {
    this.store = store
    this.now = now
    this.newId = newId
  }

  async createEvent(input: CreateEventInput): Promise<Event> {
    const name = input.name.trim()
    if (name.length < 2) {
      throw new EventValidationError('Event name must contain at least 2 characters')
    }

    if (!input.organizationId.trim()) {
      throw new EventValidationError('organizationId is required')
    }

    if (Number.isNaN(input.startAt.getTime())) {
      throw new EventValidationError('startAt must be a valid date')
    }

    const endAt = input.endAt ?? null
    if (endAt && Number.isNaN(endAt.getTime())) {
      throw new EventValidationError('endAt must be a valid date')
    }

    if (endAt && endAt < input.startAt) {
      throw new EventValidationError('endAt cannot be earlier than startAt')
    }

    const guestCount = input.guestCount ?? 0
    if (!Number.isInteger(guestCount) || guestCount < 0) {
      throw new EventValidationError('guestCount must be a non-negative integer')
    }

    const now = this.now()
    const event: Event = {
      id: this.newId(),
      organizationId: input.organizationId,
      name,
      type: input.type,
      startAt: input.startAt,
      endAt,
      venueName: input.venueName?.trim() || null,
      venueAddress: input.venueAddress?.trim() || null,
      guestCount,
      status: 'planning',
      healthScore: 100,
      ownerUserId: input.ownerUserId ?? null,
      createdAt: now,
      updatedAt: now,
    }

    const domainEvent: DomainEvent = {
      id: this.newId(),
      organizationId: event.organizationId,
      eventType: 'event.created',
      aggregateType: 'event',
      aggregateId: event.id,
      occurredAt: now,
      payload: {
        eventId: event.id,
        name: event.name,
        type: event.type,
        startAt: event.startAt.toISOString(),
      },
    }

    await this.store.createEventWithOutbox(event, domainEvent)
    return event
  }

  async getEvent(organizationId: string, eventId: string): Promise<Event | null> {
    return this.store.findEventById(organizationId, eventId)
  }

  async listEvents(organizationId: string): Promise<Event[]> {
    return this.store.listEvents(organizationId)
  }
}
