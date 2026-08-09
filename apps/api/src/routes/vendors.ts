import type { Hono } from 'hono'
import { z } from 'zod'
import {
  attachVendorToEventSchema, confirmVendorSchema, createVendorSchema, declineVendorSchema,
  requestVendorConfirmationSchema, updateEventVendorSchema,
} from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import type { EventVendor, Vendor } from '@ecc/domain'
import {
  DuplicateEventVendorError, EventVendorNotFoundError, VendorNotFoundError, VendorValidationError,
} from '@ecc/domain'
import type { VendorEngine } from '@ecc/event-engine'

export function registerVendorRoutes(app: Hono, organizations: OrganizationRepository, engine: VendorEngine): void {
  app.post('/api/v1/vendors', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const parsed = createVendorSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, 'Invalid vendor payload', parsed.error.issues)
    const vendor = await engine.createVendor({ organizationId, ...parsed.data })
    return c.json({ data: serializeVendor(vendor) }, 201)
  })

  app.get('/api/v1/vendors', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    return c.json({ data: (await engine.listVendors(organizationId)).map(serializeVendor) })
  })

  app.get('/api/v1/vendors/:id', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const vendorId = c.req.param('id')
    if (!z.uuid().safeParse(vendorId).success) return c.json({ error: { code: 'INVALID_VENDOR_ID', message: 'Vendor id must be a UUID' } }, 400)
    const vendor = await engine.getVendor(organizationId, vendorId)
    return vendor ? c.json({ data: serializeVendor(vendor) }) : c.json({ error: { code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' } }, 404)
  })

  app.post('/api/v1/events/:eventId/vendors', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const eventId = c.req.param('eventId')
    if (!z.uuid().safeParse(eventId).success) return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'Event id must be a UUID' } }, 400)
    const parsed = attachVendorToEventSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, 'Invalid event vendor payload', parsed.error.issues)
    try {
      const assignment = await engine.attachVendorToEvent({
        organizationId, eventId, ...parsed.data,
        arrivalAt: parsed.data.arrivalAt ? new Date(parsed.data.arrivalAt) : parsed.data.arrivalAt,
        departureAt: parsed.data.departureAt ? new Date(parsed.data.departureAt) : parsed.data.departureAt,
      })
      return c.json({ data: serializeEventVendor(assignment) }, 201)
    } catch (error) { return handleVendorError(c, error) }
  })

  app.get('/api/v1/events/:eventId/vendors', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const eventId = c.req.param('eventId')
    if (!z.uuid().safeParse(eventId).success) return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'Event id must be a UUID' } }, 400)
    return c.json({ data: (await engine.listEventVendors(organizationId, eventId)).map(serializeEventVendor) })
  })

  app.patch('/api/v1/events/:eventId/vendors/:eventVendorId', async (c) => {
    const ids = await resolveEventVendorIds(c, organizations)
    if (!ids) return
    if ('response' in ids) return ids.response
    const parsed = updateEventVendorSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, 'Invalid event vendor update', parsed.error.issues)
    try {
      const updated = await engine.updateEventVendor({
        organizationId: ids.organizationId, eventId: ids.eventId, eventVendorId: ids.eventVendorId, ...parsed.data,
        arrivalAt: parsed.data.arrivalAt ? new Date(parsed.data.arrivalAt) : parsed.data.arrivalAt,
        departureAt: parsed.data.departureAt ? new Date(parsed.data.departureAt) : parsed.data.departureAt,
      })
      return c.json({ data: serializeEventVendor(updated) })
    } catch (error) { return handleVendorError(c, error) }
  })

  app.post('/api/v1/events/:eventId/vendors/:eventVendorId/confirmation-request', async (c) => {
    const ids = await resolveEventVendorIds(c, organizations)
    if (!ids) return
    if ('response' in ids) return ids.response
    const parsed = requestVendorConfirmationSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, 'Invalid confirmation request', parsed.error.issues)
    try {
      const updated = await engine.requestConfirmation({
        ...ids,
        deadlineAt: parsed.data.deadlineAt ? new Date(parsed.data.deadlineAt) : parsed.data.deadlineAt,
      })
      return c.json({ data: serializeEventVendor(updated) })
    } catch (error) { return handleVendorError(c, error) }
  })

  app.post('/api/v1/events/:eventId/vendors/:eventVendorId/confirm', async (c) => {
    const ids = await resolveEventVendorIds(c, organizations)
    if (!ids) return
    if ('response' in ids) return ids.response
    const parsed = confirmVendorSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, 'Invalid vendor confirmation', parsed.error.issues)
    try {
      const updated = await engine.confirm({
        ...ids, ...parsed.data,
        arrivalAt: parsed.data.arrivalAt ? new Date(parsed.data.arrivalAt) : parsed.data.arrivalAt,
        departureAt: parsed.data.departureAt ? new Date(parsed.data.departureAt) : parsed.data.departureAt,
      })
      return c.json({ data: serializeEventVendor(updated) })
    } catch (error) { return handleVendorError(c, error) }
  })

  app.post('/api/v1/events/:eventId/vendors/:eventVendorId/decline', async (c) => {
    const ids = await resolveEventVendorIds(c, organizations)
    if (!ids) return
    if ('response' in ids) return ids.response
    const parsed = declineVendorSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, 'Invalid vendor decline payload', parsed.error.issues)
    try {
      const updated = await engine.decline({ ...ids, ...parsed.data })
      return c.json({ data: serializeEventVendor(updated) })
    } catch (error) { return handleVendorError(c, error) }
  })
}

async function resolveOrganizationId(c: any, organizations: OrganizationRepository): Promise<string | any> {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId) return c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400)
  if (!z.uuid().safeParse(organizationId).success) return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400)
  if (!(await organizations.exists(organizationId))) return c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404)
  return organizationId
}

async function resolveEventVendorIds(c: any, organizations: OrganizationRepository): Promise<any> {
  const organizationId = await resolveOrganizationId(c, organizations)
  if (typeof organizationId !== 'string') return { response: organizationId }
  const eventId = c.req.param('eventId')
  const eventVendorId = c.req.param('eventVendorId')
  if (!z.uuid().safeParse(eventId).success || !z.uuid().safeParse(eventVendorId).success) {
    return { response: c.json({ error: { code: 'INVALID_ID', message: 'Event and event vendor ids must be UUIDs' } }, 400) }
  }
  return { organizationId, eventId, eventVendorId }
}

function handleVendorError(c: any, error: unknown) {
  if (error instanceof VendorNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404)
  if (error instanceof EventVendorNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404)
  if (error instanceof DuplicateEventVendorError) return c.json({ error: { code: error.code, message: error.message } }, 409)
  if (error instanceof VendorValidationError) return c.json({ error: { code: error.code, message: error.message } }, 400)
  throw error
}
function validationError(c: any, message: string, issues: unknown) { return c.json({ error: { code: 'VALIDATION_ERROR', message, issues } }, 400) }
function serializeVendor(v: Vendor) { return { ...v, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString() } }
function serializeEventVendor(v: EventVendor) {
  return {
    ...v,
    arrivalAt: v.arrivalAt?.toISOString() ?? null,
    departureAt: v.departureAt?.toISOString() ?? null,
    confirmationRequestedAt: v.confirmationRequestedAt?.toISOString() ?? null,
    confirmationDeadlineAt: v.confirmationDeadlineAt?.toISOString() ?? null,
    confirmedAt: v.confirmedAt?.toISOString() ?? null,
    declinedAt: v.declinedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(),
  }
}
