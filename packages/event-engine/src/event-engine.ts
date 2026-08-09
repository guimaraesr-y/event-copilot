import {
  EventTaskNotFoundError,
  EventTemplateNotFoundError,
  EventValidationError,
  type CreateEventInput,
  type CreateManualTaskInput,
  type DomainEvent,
  type Event,
  type EventMilestone,
  type EventStore,
  type EventTask,
  type UpdateTaskInput,
} from '@ecc/domain'
import { scheduleRelativeToEvent } from './schedule.ts'

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

    if (!input.organizationTimezone.trim()) {
      throw new EventValidationError('organizationTimezone is required')
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

    const templateId = input.templateId ?? null
    const template = templateId
      ? await this.store.findTemplateSnapshot(input.organizationId, templateId)
      : null

    if (templateId && !template) {
      throw new EventTemplateNotFoundError()
    }
    if (template && !template.isActive) {
      throw new EventValidationError('Event template is inactive')
    }
    if (template && template.eventType !== input.type) {
      throw new EventValidationError(
        `Template event type ${template.eventType} cannot be used for event type ${input.type}`,
      )
    }

    const now = this.now()
    const event: Event = {
      id: this.newId(),
      organizationId: input.organizationId,
      templateId,
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

    const tasks: EventTask[] = (template?.tasks ?? []).map((templateTask) => ({
      id: this.newId(),
      organizationId: event.organizationId,
      eventId: event.id,
      templateTaskId: templateTask.id,
      title: templateTask.title,
      description: templateTask.description,
      type: templateTask.type,
      status: 'pending',
      priority: templateTask.priority,
      dueAt: scheduleRelativeToEvent(
        event.startAt,
        templateTask.offsetDays,
        templateTask.dueTime,
        input.organizationTimezone,
      ),
      source: 'template',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }))

    const milestones: EventMilestone[] = (template?.milestones ?? []).map((templateMilestone) => ({
      id: this.newId(),
      organizationId: event.organizationId,
      eventId: event.id,
      templateMilestoneId: templateMilestone.id,
      name: templateMilestone.name,
      description: templateMilestone.description,
      dueAt: scheduleRelativeToEvent(
        event.startAt,
        templateMilestone.offsetDays,
        templateMilestone.dueTime,
        input.organizationTimezone,
      ),
      status: 'pending',
      source: 'template',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }))

    const domainEvents: DomainEvent[] = [
      {
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
          templateId: event.templateId,
        },
      },
    ]

    if (template) {
      domainEvents.push({
        id: this.newId(),
        organizationId: event.organizationId,
        eventType: 'event.plan_initialized',
        aggregateType: 'event',
        aggregateId: event.id,
        occurredAt: now,
        payload: {
          eventId: event.id,
          templateId: template.id,
          templateName: template.name,
          tasksCreated: tasks.length,
          milestonesCreated: milestones.length,
        },
      })
    }

    await this.store.createEventWithPlan(event, tasks, milestones, domainEvents)
    return event
  }

  async getEvent(organizationId: string, eventId: string): Promise<Event | null> {
    return this.store.findEventById(organizationId, eventId)
  }

  async listEvents(organizationId: string): Promise<Event[]> {
    return this.store.listEvents(organizationId)
  }

  async listTasks(organizationId: string, eventId: string): Promise<EventTask[]> {
    return this.store.listEventTasks(organizationId, eventId)
  }

  async listMilestones(organizationId: string, eventId: string): Promise<EventMilestone[]> {
    return this.store.listEventMilestones(organizationId, eventId)
  }

  async createManualTask(input: CreateManualTaskInput): Promise<EventTask> {
    const event = await this.store.findEventById(input.organizationId, input.eventId)
    if (!event) throw new EventValidationError('Event not found')

    const title = input.title.trim()
    if (title.length < 2) throw new EventValidationError('Task title must contain at least 2 characters')
    if (Number.isNaN(input.dueAt.getTime())) throw new EventValidationError('dueAt must be a valid date')

    const now = this.now()
    const task: EventTask = {
      id: this.newId(),
      organizationId: input.organizationId,
      eventId: input.eventId,
      templateTaskId: null,
      title,
      description: input.description?.trim() || null,
      type: input.type ?? 'general',
      status: 'pending',
      priority: input.priority ?? 'normal',
      dueAt: input.dueAt,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }

    const domainEvent: DomainEvent = {
      id: this.newId(),
      organizationId: task.organizationId,
      eventType: 'task.created',
      aggregateType: 'task',
      aggregateId: task.id,
      occurredAt: now,
      payload: {
        eventId: task.eventId,
        taskId: task.id,
        title: task.title,
        dueAt: task.dueAt.toISOString(),
        source: task.source,
      },
    }

    await this.store.createTaskWithOutbox(task, domainEvent)
    return task
  }

  async updateTask(input: UpdateTaskInput): Promise<EventTask> {
    const current = await this.store.findTaskById(input.organizationId, input.eventId, input.taskId)
    if (!current) throw new EventTaskNotFoundError()

    const now = this.now()
    const title = input.title === undefined ? current.title : input.title.trim()
    if (title.length < 2) throw new EventValidationError('Task title must contain at least 2 characters')
    if (input.dueAt && Number.isNaN(input.dueAt.getTime())) {
      throw new EventValidationError('dueAt must be a valid date')
    }

    const status = input.status ?? current.status
    const justCompleted = current.status !== 'completed' && status === 'completed'
    const task: EventTask = {
      ...current,
      title,
      description: input.description === undefined ? current.description : input.description?.trim() || null,
      status,
      priority: input.priority ?? current.priority,
      dueAt: input.dueAt ?? current.dueAt,
      updatedAt: now,
      completedAt: status === 'completed' ? (current.completedAt ?? now) : null,
    }

    const domainEvent: DomainEvent = {
      id: this.newId(),
      organizationId: task.organizationId,
      eventType: justCompleted ? 'task.completed' : 'task.updated',
      aggregateType: 'task',
      aggregateId: task.id,
      occurredAt: now,
      payload: {
        eventId: task.eventId,
        taskId: task.id,
        status: task.status,
        dueAt: task.dueAt.toISOString(),
      },
    }

    await this.store.updateTaskWithOutbox(task, domainEvent)
    return task
  }
}
