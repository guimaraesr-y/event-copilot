import type { Hono } from 'hono'
import { z } from 'zod'
import {
  createEventTemplateMilestoneSchema,
  createEventTemplateSchema,
  createEventTemplateTaskSchema,
} from '@ecc/contracts'
import type { EventTemplateRepository, OrganizationRepository } from '@ecc/database'
import type { EventTemplate, EventTemplateMilestone, EventTemplateSnapshot, EventTemplateTask } from '@ecc/domain'

export function registerEventTemplateRoutes(
  app: Hono,
  organizations: OrganizationRepository,
  templates: EventTemplateRepository,
): void {
  app.post('/api/v1/event-templates', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId

    const body = await c.req.json().catch(() => null)
    const parsed = createEventTemplateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid event template payload', issues: parsed.error.issues } },
        400,
      )
    }

    const template = await templates.create({
      organizationId,
      name: parsed.data.name,
      eventType: parsed.data.eventType,
      description: parsed.data.description ?? null,
    })
    return c.json({ data: serializeTemplate(template) }, 201)
  })

  app.get('/api/v1/event-templates', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    return c.json({ data: (await templates.list(organizationId)).map(serializeTemplate) })
  })

  app.get('/api/v1/event-templates/:id', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const templateId = c.req.param('id')
    if (!z.uuid().safeParse(templateId).success) {
      return c.json({ error: { code: 'INVALID_TEMPLATE_ID', message: 'Template id must be a UUID' } }, 400)
    }

    const template = await templates.findSnapshot(organizationId, templateId)
    if (!template) {
      return c.json({ error: { code: 'EVENT_TEMPLATE_NOT_FOUND', message: 'Event template not found' } }, 404)
    }
    return c.json({ data: serializeTemplateSnapshot(template) })
  })

  app.post('/api/v1/event-templates/:id/tasks', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const templateId = c.req.param('id')
    if (!z.uuid().safeParse(templateId).success) {
      return c.json({ error: { code: 'INVALID_TEMPLATE_ID', message: 'Template id must be a UUID' } }, 400)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = createEventTemplateTaskSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid template task payload', issues: parsed.error.issues } },
        400,
      )
    }

    const task = await templates.addTask({
      organizationId,
      templateId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      offsetDays: parsed.data.offsetDays,
      dueTime: parsed.data.dueTime,
      priority: parsed.data.priority,
      type: parsed.data.type,
      sortOrder: parsed.data.sortOrder,
    })
    if (!task) return c.json({ error: { code: 'EVENT_TEMPLATE_NOT_FOUND', message: 'Event template not found' } }, 404)
    return c.json({ data: serializeTemplateTask(task) }, 201)
  })

  app.delete('/api/v1/event-templates/:templateId/tasks/:taskId', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const templateId = c.req.param('templateId')
    const taskId = c.req.param('taskId')
    if (!z.uuid().safeParse(templateId).success || !z.uuid().safeParse(taskId).success) {
      return c.json({ error: { code: 'INVALID_ID', message: 'Template and task ids must be UUIDs' } }, 400)
    }
    const deleted = await templates.deleteTask(organizationId, templateId, taskId)
    return deleted ? c.body(null, 204) : c.json({ error: { code: 'TEMPLATE_TASK_NOT_FOUND', message: 'Template task not found' } }, 404)
  })

  app.post('/api/v1/event-templates/:id/milestones', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const templateId = c.req.param('id')
    if (!z.uuid().safeParse(templateId).success) {
      return c.json({ error: { code: 'INVALID_TEMPLATE_ID', message: 'Template id must be a UUID' } }, 400)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = createEventTemplateMilestoneSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid template milestone payload', issues: parsed.error.issues } },
        400,
      )
    }

    const milestone = await templates.addMilestone({
      organizationId,
      templateId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      offsetDays: parsed.data.offsetDays,
      dueTime: parsed.data.dueTime,
      sortOrder: parsed.data.sortOrder,
    })
    if (!milestone) return c.json({ error: { code: 'EVENT_TEMPLATE_NOT_FOUND', message: 'Event template not found' } }, 404)
    return c.json({ data: serializeTemplateMilestone(milestone) }, 201)
  })

  app.delete('/api/v1/event-templates/:templateId/milestones/:milestoneId', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const templateId = c.req.param('templateId')
    const milestoneId = c.req.param('milestoneId')
    if (!z.uuid().safeParse(templateId).success || !z.uuid().safeParse(milestoneId).success) {
      return c.json({ error: { code: 'INVALID_ID', message: 'Template and milestone ids must be UUIDs' } }, 400)
    }
    const deleted = await templates.deleteMilestone(organizationId, templateId, milestoneId)
    return deleted
      ? c.body(null, 204)
      : c.json({ error: { code: 'TEMPLATE_MILESTONE_NOT_FOUND', message: 'Template milestone not found' } }, 404)
  })
}

async function resolveOrganizationId(c: any, organizations: OrganizationRepository): Promise<string | any> {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId) {
    return c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400)
  }
  if (!z.uuid().safeParse(organizationId).success) {
    return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400)
  }
  if (!(await organizations.exists(organizationId))) {
    return c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404)
  }
  return organizationId
}

function serializeTemplate(template: EventTemplate) {
  return {
    ...template,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  }
}

function serializeTemplateSnapshot(template: EventTemplateSnapshot) {
  return {
    ...serializeTemplate(template),
    tasks: template.tasks.map(serializeTemplateTask),
    milestones: template.milestones.map(serializeTemplateMilestone),
  }
}

function serializeTemplateTask(task: EventTemplateTask) {
  return { ...task, createdAt: task.createdAt.toISOString() }
}

function serializeTemplateMilestone(milestone: EventTemplateMilestone) {
  return { ...milestone, createdAt: milestone.createdAt.toISOString() }
}
