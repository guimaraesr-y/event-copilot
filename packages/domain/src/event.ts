import type { DomainEvent } from './outbox.ts'
import type { EventMilestone } from './milestone.ts'
import type { EventTask } from './task.ts'
import type { EventTemplateSnapshot } from './template.ts'

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
  templateId: string | null
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
  organizationTimezone: string
  templateId?: string | null
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
  findTemplateSnapshot(organizationId: string, templateId: string): Promise<EventTemplateSnapshot | null>
  createEventWithPlan(
    event: Event,
    tasks: EventTask[],
    milestones: EventMilestone[],
    domainEvents: DomainEvent[],
  ): Promise<void>
  findEventById(organizationId: string, eventId: string): Promise<Event | null>
  listEvents(organizationId: string): Promise<Event[]>
  listEventTasks(organizationId: string, eventId: string): Promise<EventTask[]>
  listEventMilestones(organizationId: string, eventId: string): Promise<EventMilestone[]>
  createTaskWithOutbox(task: EventTask, domainEvent: DomainEvent): Promise<void>
  updateTaskWithOutbox(task: EventTask, domainEvent: DomainEvent): Promise<void>
  findTaskById(organizationId: string, eventId: string, taskId: string): Promise<EventTask | null>
}

export class EventValidationError extends Error {
  readonly code = 'EVENT_VALIDATION_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'EventValidationError'
  }
}

export class EventTemplateNotFoundError extends Error {
  readonly code = 'EVENT_TEMPLATE_NOT_FOUND'

  constructor(message = 'Event template not found') {
    super(message)
    this.name = 'EventTemplateNotFoundError'
  }
}

export class EventTaskNotFoundError extends Error {
  readonly code = 'EVENT_TASK_NOT_FOUND'

  constructor(message = 'Event task not found') {
    super(message)
    this.name = 'EventTaskNotFoundError'
  }
}

