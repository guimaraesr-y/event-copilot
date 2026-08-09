import type { Hono } from 'hono'
import { z } from 'zod'
import { createEventSchema, createEventTaskSchema, updateEventTaskSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import {
  EventTaskNotFoundError,
  EventTemplateNotFoundError,
  EventValidationError,
  type Event,
  type EventMilestone,
  type EventTask,
} from '@ecc/domain'
import type { EventEngine } from '@ecc/event-engine'

export function registerEventRoutes(
  app: Hono,
  organizations: OrganizationRepository,
  eventEngine: EventEngine,
): void {
  app.post('/api/v1/events', async (c) => {
    const organizationId = c.req.header('x-organization-id')
    if (!organizationId) {
      return c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400)
    }
    if (!z.uuid().safeParse(organizationId).success) {
      return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400)
    }

    const organization = await organizations.findById(organizationId)
    if (!organization) {
      return c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = createEventSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid event payload', issues: parsed.error.issues } },
        400,
      )
    }

    try {
      const event = await eventEngine.createEvent({
        organizationId,
        organizationTimezone: organization.timezone,
        templateId: parsed.data.templateId ?? null,
        name: parsed.data.name,
        type: parsed.data.type,
        startAt: new Date(parsed.data.startAt),
        endAt: parsed.data.endAt ? new Date(parsed.data.endAt) : null,
        venueName: parsed.data.venueName ?? null,
        venueAddress: parsed.data.venueAddress ?? null,
        guestCount: parsed.data.guestCount,
        ownerUserId: parsed.data.ownerUserId ?? null,
      })
      return c.json({ data: serializeEvent(event) }, 201)
    } catch (error) {
      if (error instanceof EventTemplateNotFoundError) {
        return c.json({ error: { code: error.code, message: error.message } }, 404)
      }
      if (error instanceof EventValidationError) {
        return c.json({ error: { code: error.code, message: error.message } }, 400)
      }
      throw error
    }
  })

  app.get('/api/v1/events', async (c) => {
    const organizationId = c.req.header('x-organization-id')
    if (!organizationId) {
      return c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400)
    }
    if (!z.uuid().safeParse(organizationId).success) {
      return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400)
    }

    const events = await eventEngine.listEvents(organizationId)
    return c.json({ data: events.map(serializeEvent) })
  })

  app.get('/api/v1/events/:id', async (c) => {
    const context = getEventContext(c)
    if ('response' in context) return context.response
    const event = await eventEngine.getEvent(context.organizationId, context.eventId)
    if (!event) return c.json({ error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } }, 404)
    return c.json({ data: serializeEvent(event) })
  })

  app.get('/api/v1/events/:id/tasks', async (c) => {
    const context = getEventContext(c)
    if ('response' in context) return context.response
    const event = await eventEngine.getEvent(context.organizationId, context.eventId)
    if (!event) return c.json({ error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } }, 404)
    return c.json({ data: (await eventEngine.listTasks(context.organizationId, context.eventId)).map(serializeTask) })
  })

  app.post('/api/v1/events/:id/tasks', async (c) => {
    const context = getEventContext(c)
    if ('response' in context) return context.response
    const body = await c.req.json().catch(() => null)
    const parsed = createEventTaskSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid task payload', issues: parsed.error.issues } }, 400)
    }

    try {
      const task = await eventEngine.createManualTask({
        organizationId: context.organizationId,
        eventId: context.eventId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        type: parsed.data.type,
        priority: parsed.data.priority,
        dueAt: new Date(parsed.data.dueAt),
      })
      return c.json({ data: serializeTask(task) }, 201)
    } catch (error) {
      if (error instanceof EventValidationError) {
        const status = error.message === 'Event not found' ? 404 : 400
        return c.json({ error: { code: error.code, message: error.message } }, status)
      }
      throw error
    }
  })

  app.patch('/api/v1/events/:eventId/tasks/:taskId', async (c) => {
    const organizationId = c.req.header('x-organization-id')
    if (!organizationId || !z.uuid().safeParse(organizationId).success) {
      return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'A valid x-organization-id is required' } }, 400)
    }
    const eventId = c.req.param('eventId')
    const taskId = c.req.param('taskId')
    if (!z.uuid().safeParse(eventId).success || !z.uuid().safeParse(taskId).success) {
      return c.json({ error: { code: 'INVALID_ID', message: 'Event and task ids must be UUIDs' } }, 400)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = updateEventTaskSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid task update payload', issues: parsed.error.issues } }, 400)
    }

    try {
      const task = await eventEngine.updateTask({
        organizationId,
        eventId,
        taskId,
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.dueAt !== undefined ? { dueAt: new Date(parsed.data.dueAt) } : {}),
      })
      return c.json({ data: serializeTask(task) })
    } catch (error) {
      if (error instanceof EventTaskNotFoundError) {
        return c.json({ error: { code: error.code, message: error.message } }, 404)
      }
      if (error instanceof EventValidationError) {
        return c.json({ error: { code: error.code, message: error.message } }, 400)
      }
      throw error
    }
  })

  app.get('/api/v1/events/:id/milestones', async (c) => {
    const context = getEventContext(c)
    if ('response' in context) return context.response
    const event = await eventEngine.getEvent(context.organizationId, context.eventId)
    if (!event) return c.json({ error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } }, 404)
    return c.json({ data: (await eventEngine.listMilestones(context.organizationId, context.eventId)).map(serializeMilestone) })
  })
}

function getEventContext(c: any):
  | { ok: true; organizationId: string; eventId: string }
  | { ok: false; response: any } {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId) {
    return { ok: false, response: c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400) }
  }
  if (!z.uuid().safeParse(organizationId).success) {
    return { ok: false, response: c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400) }
  }
  const eventId = c.req.param('id')
  if (!z.uuid().safeParse(eventId).success) {
    return { ok: false, response: c.json({ error: { code: 'INVALID_EVENT_ID', message: 'Event id must be a UUID' } }, 400) }
  }
  return { ok: true, organizationId, eventId }
}

function serializeEvent(event: Event) {
  return {
    ...event,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  }
}

function serializeTask(task: EventTask) {
  return {
    ...task,
    dueAt: task.dueAt.toISOString(),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
  }
}

function serializeMilestone(milestone: EventMilestone) {
  return {
    ...milestone,
    dueAt: milestone.dueAt.toISOString(),
    createdAt: milestone.createdAt.toISOString(),
    updatedAt: milestone.updatedAt.toISOString(),
    completedAt: milestone.completedAt?.toISOString() ?? null,
  }
}
