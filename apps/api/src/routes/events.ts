import type { Hono } from 'hono'
import { z } from 'zod'
import { createEventSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import { EventValidationError, type Event } from '@ecc/domain'
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

    if (!(await organizations.exists(organizationId))) {
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
    const organizationId = c.req.header('x-organization-id')
    if (!organizationId) {
      return c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400)
    }
    if (!z.uuid().safeParse(organizationId).success) {
      return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400)
    }

    const eventId = c.req.param('id')
    if (!z.uuid().safeParse(eventId).success) {
      return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'Event id must be a UUID' } }, 400)
    }

    const event = await eventEngine.getEvent(organizationId, eventId)
    if (!event) {
      return c.json({ error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } }, 404)
    }

    return c.json({ data: serializeEvent(event) })
  })
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
