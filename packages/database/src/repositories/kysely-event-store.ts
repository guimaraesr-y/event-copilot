import type { Kysely, Transaction } from 'kysely'
import type {
  DomainEvent,
  Event,
  EventMilestone,
  EventStore,
  EventTask,
  EventTemplateSnapshot,
} from '@ecc/domain'
import type { DatabaseSchema } from '../db-types.ts'
import { EventTemplateRepository } from './event-template-repository.ts'

export class KyselyEventStore implements EventStore {
  private readonly templates: EventTemplateRepository

  constructor(private readonly db: Kysely<DatabaseSchema>) {
    this.templates = new EventTemplateRepository(db)
  }

  async findTemplateSnapshot(organizationId: string, templateId: string): Promise<EventTemplateSnapshot | null> {
    return this.templates.findSnapshot(organizationId, templateId)
  }

  async createEventWithPlan(
    event: Event,
    tasks: EventTask[],
    milestones: EventMilestone[],
    domainEvents: DomainEvent[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.insertEvent(trx, event)

      if (tasks.length > 0) {
        await trx.insertInto('event_tasks').values(tasks.map((task) => this.taskValues(task))).execute()
      }

      if (milestones.length > 0) {
        await trx
          .insertInto('event_milestones')
          .values(milestones.map((milestone) => this.milestoneValues(milestone)))
          .execute()
      }

      for (const domainEvent of domainEvents) {
        await this.insertOutbox(trx, domainEvent)
      }
    })
  }

  async findEventById(organizationId: string, eventId: string): Promise<Event | null> {
    const row = await this.db
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', eventId)
      .executeTakeFirst()
    return row ? this.mapEvent(row) : null
  }

  async listEvents(organizationId: string): Promise<Event[]> {
    const rows = await this.db
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('start_at', 'asc')
      .execute()
    return rows.map((row) => this.mapEvent(row))
  }

  async listEventTasks(organizationId: string, eventId: string): Promise<EventTask[]> {
    const rows = await this.db
      .selectFrom('event_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .orderBy('due_at', 'asc')
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => this.mapTask(row))
  }

  async listEventMilestones(organizationId: string, eventId: string): Promise<EventMilestone[]> {
    const rows = await this.db
      .selectFrom('event_milestones')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .orderBy('due_at', 'asc')
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((row) => this.mapMilestone(row))
  }

  async findTaskById(organizationId: string, eventId: string, taskId: string): Promise<EventTask | null> {
    const row = await this.db
      .selectFrom('event_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .where('id', '=', taskId)
      .executeTakeFirst()
    return row ? this.mapTask(row) : null
  }

  async createTaskWithOutbox(task: EventTask, domainEvent: DomainEvent): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('event_tasks').values(this.taskValues(task)).execute()
      await this.insertOutbox(trx, domainEvent)
    })
  }

  async updateTaskWithOutbox(task: EventTask, domainEvent: DomainEvent): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('event_tasks')
        .set({
          title: task.title,
          description: task.description,
          type: task.type,
          status: task.status,
          priority: task.priority,
          due_at: task.dueAt,
          updated_at: task.updatedAt,
          completed_at: task.completedAt,
        })
        .where('organization_id', '=', task.organizationId)
        .where('event_id', '=', task.eventId)
        .where('id', '=', task.id)
        .execute()
      await this.insertOutbox(trx, domainEvent)
    })
  }

  private async insertEvent(trx: Transaction<DatabaseSchema>, event: Event): Promise<void> {
    await trx
      .insertInto('events')
      .values({
        id: event.id,
        organization_id: event.organizationId,
        template_id: event.templateId,
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

  private async insertOutbox(trx: Transaction<DatabaseSchema>, domainEvent: DomainEvent): Promise<void> {
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
  }

  private taskValues(task: EventTask) {
    return {
      id: task.id,
      organization_id: task.organizationId,
      event_id: task.eventId,
      template_task_id: task.templateTaskId,
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      priority: task.priority,
      due_at: task.dueAt,
      source: task.source,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      completed_at: task.completedAt,
    }
  }

  private milestoneValues(milestone: EventMilestone) {
    return {
      id: milestone.id,
      organization_id: milestone.organizationId,
      event_id: milestone.eventId,
      template_milestone_id: milestone.templateMilestoneId,
      name: milestone.name,
      description: milestone.description,
      due_at: milestone.dueAt,
      status: milestone.status,
      source: milestone.source,
      created_at: milestone.createdAt,
      updated_at: milestone.updatedAt,
      completed_at: milestone.completedAt,
    }
  }

  private mapEvent(row: {
    id: string
    organization_id: string
    template_id: string | null
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

  private mapTask(row: {
    id: string
    organization_id: string
    event_id: string
    template_task_id: string | null
    title: string
    description: string | null
    type: EventTask['type']
    status: EventTask['status']
    priority: EventTask['priority']
    due_at: Date
    source: EventTask['source']
    created_at: Date
    updated_at: Date
    completed_at: Date | null
  }): EventTask {
    return {
      id: row.id,
      organizationId: row.organization_id,
      eventId: row.event_id,
      templateTaskId: row.template_task_id,
      title: row.title,
      description: row.description,
      type: row.type,
      status: row.status,
      priority: row.priority,
      dueAt: row.due_at,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }
  }

  private mapMilestone(row: {
    id: string
    organization_id: string
    event_id: string
    template_milestone_id: string | null
    name: string
    description: string | null
    due_at: Date
    status: EventMilestone['status']
    source: EventMilestone['source']
    created_at: Date
    updated_at: Date
    completed_at: Date | null
  }): EventMilestone {
    return {
      id: row.id,
      organizationId: row.organization_id,
      eventId: row.event_id,
      templateMilestoneId: row.template_milestone_id,
      name: row.name,
      description: row.description,
      dueAt: row.due_at,
      status: row.status,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }
  }
}
