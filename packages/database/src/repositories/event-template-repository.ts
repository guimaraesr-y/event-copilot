import type { Kysely } from 'kysely'
import type {
  EventTemplate,
  EventTemplateMilestone,
  EventTemplateSnapshot,
  EventTemplateTask,
  EventType,
  TaskPriority,
  TaskType,
} from '@ecc/domain'
import type { DatabaseSchema } from '../db-types.ts'

export interface CreateEventTemplateRecord {
  organizationId: string
  name: string
  eventType: EventType
  description: string | null
}

export interface CreateEventTemplateTaskRecord {
  organizationId: string
  templateId: string
  title: string
  description: string | null
  offsetDays: number
  dueTime: string
  priority: TaskPriority
  type: TaskType
  sortOrder: number
}

export interface CreateEventTemplateMilestoneRecord {
  organizationId: string
  templateId: string
  name: string
  description: string | null
  offsetDays: number
  dueTime: string
  sortOrder: number
}

export class EventTemplateRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async create(input: CreateEventTemplateRecord): Promise<EventTemplate> {
    const now = new Date()
    const row = await this.db
      .insertInto('event_templates')
      .values({
        id: crypto.randomUUID(),
        organization_id: input.organizationId,
        name: input.name.trim(),
        event_type: input.eventType,
        description: input.description?.trim() || null,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return this.mapTemplate(row)
  }

  async list(organizationId: string): Promise<EventTemplate[]> {
    const rows = await this.db
      .selectFrom('event_templates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name', 'asc')
      .execute()
    return rows.map((row) => this.mapTemplate(row))
  }

  async findSnapshot(organizationId: string, templateId: string): Promise<EventTemplateSnapshot | null> {
    const template = await this.db
      .selectFrom('event_templates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', templateId)
      .executeTakeFirst()
    if (!template) return null

    const [tasks, milestones] = await Promise.all([
      this.db
        .selectFrom('event_template_tasks')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('template_id', '=', templateId)
        .orderBy('sort_order', 'asc')
        .orderBy('created_at', 'asc')
        .execute(),
      this.db
        .selectFrom('event_template_milestones')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('template_id', '=', templateId)
        .orderBy('sort_order', 'asc')
        .orderBy('created_at', 'asc')
        .execute(),
    ])

    return {
      ...this.mapTemplate(template),
      tasks: tasks.map((row) => this.mapTask(row)),
      milestones: milestones.map((row) => this.mapMilestone(row)),
    }
  }

  async addTask(input: CreateEventTemplateTaskRecord): Promise<EventTemplateTask | null> {
    const template = await this.db
      .selectFrom('event_templates')
      .select(['id'])
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.templateId)
      .executeTakeFirst()
    if (!template) return null

    const row = await this.db
      .insertInto('event_template_tasks')
      .values({
        id: crypto.randomUUID(),
        organization_id: input.organizationId,
        template_id: input.templateId,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        offset_days: input.offsetDays,
        due_time: input.dueTime,
        priority: input.priority,
        type: input.type,
        sort_order: input.sortOrder,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return this.mapTask(row)
  }

  async addMilestone(input: CreateEventTemplateMilestoneRecord): Promise<EventTemplateMilestone | null> {
    const template = await this.db
      .selectFrom('event_templates')
      .select(['id'])
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.templateId)
      .executeTakeFirst()
    if (!template) return null

    const row = await this.db
      .insertInto('event_template_milestones')
      .values({
        id: crypto.randomUUID(),
        organization_id: input.organizationId,
        template_id: input.templateId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        offset_days: input.offsetDays,
        due_time: input.dueTime,
        sort_order: input.sortOrder,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return this.mapMilestone(row)
  }

  async deleteTask(organizationId: string, templateId: string, taskId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('event_template_tasks')
      .where('organization_id', '=', organizationId)
      .where('template_id', '=', templateId)
      .where('id', '=', taskId)
      .executeTakeFirst()
    return Number(result.numDeletedRows) > 0
  }

  async deleteMilestone(organizationId: string, templateId: string, milestoneId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('event_template_milestones')
      .where('organization_id', '=', organizationId)
      .where('template_id', '=', templateId)
      .where('id', '=', milestoneId)
      .executeTakeFirst()
    return Number(result.numDeletedRows) > 0
  }

  private mapTemplate(row: {
    id: string
    organization_id: string
    name: string
    event_type: EventType
    description: string | null
    is_active: boolean
    created_at: Date
    updated_at: Date
  }): EventTemplate {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      eventType: row.event_type,
      description: row.description,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private mapTask(row: {
    id: string
    organization_id: string
    template_id: string
    title: string
    description: string | null
    offset_days: number
    due_time: string
    priority: TaskPriority
    type: TaskType
    sort_order: number
    created_at: Date
  }): EventTemplateTask {
    return {
      id: row.id,
      organizationId: row.organization_id,
      templateId: row.template_id,
      title: row.title,
      description: row.description,
      offsetDays: row.offset_days,
      dueTime: row.due_time,
      priority: row.priority,
      type: row.type,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
    }
  }

  private mapMilestone(row: {
    id: string
    organization_id: string
    template_id: string
    name: string
    description: string | null
    offset_days: number
    due_time: string
    sort_order: number
    created_at: Date
  }): EventTemplateMilestone {
    return {
      id: row.id,
      organizationId: row.organization_id,
      templateId: row.template_id,
      name: row.name,
      description: row.description,
      offsetDays: row.offset_days,
      dueTime: row.due_time,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
    }
  }
}
