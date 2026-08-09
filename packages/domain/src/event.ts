import type { DomainEvent } from './outbox.ts'

export const EVENT_STATUSES = [
  'draft',
  'planning',
  'confirmation',
  'ready',
  'event_day',
  'completed',
  'cancelled',
] as const

export type EventStatus = (typeof EVENT_STATUSES)[number]

export const EVENT_TYPES = ['wedding', 'birthday', 'corporate', 'other'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface Event {
  id: string
  organizationId: string
  name: string
  type: EventType
  startAt: Date
  endAt: Date | null
  venueName: string | null
  venueAddress: string | null
  guestCount: number
  status: EventStatus
  healthScore: number
  ownerUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateEventInput {
  organizationId: string
  name: string
  type: EventType
  startAt: Date
  endAt?: Date | null
  venueName?: string | null
  venueAddress?: string | null
  guestCount?: number
  ownerUserId?: string | null
}

export interface EventStore {
  createEventWithOutbox(event: Event, domainEvent: DomainEvent): Promise<void>
  findEventById(organizationId: string, eventId: string): Promise<Event | null>
  listEvents(organizationId: string): Promise<Event[]>
}

export class EventValidationError extends Error {
  readonly code = 'EVENT_VALIDATION_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'EventValidationError'
  }
}
