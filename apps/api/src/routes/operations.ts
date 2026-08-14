import type { Hono } from 'hono'
import { z } from 'zod'
import type { OperationalRepository, OrganizationRepository } from '@ecc/database'
import { ACTIVITY_CATEGORIES, INBOX_SEVERITIES, INBOX_STATUSES, type ActivityEntry, type InboxItem } from '@ecc/domain'

export function registerOperationalRoutes(app: Hono, organizations: OrganizationRepository, repo: OperationalRepository): void {
  app.get('/api/v1/events/:eventId/activity', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const eventId = c.req.param('eventId')
    if (!z.uuid().safeParse(eventId).success) return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'Event id must be a UUID' } }, 400)
    if (!(await repo.eventExists(organizationId, eventId))) return c.json({ error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } }, 404)
    const categoryRaw = c.req.query('category')
    const category = categoryRaw ? z.enum(ACTIVITY_CATEGORIES).safeParse(categoryRaw) : null
    if (categoryRaw && !category?.success) return c.json({ error: { code: 'INVALID_CATEGORY', message: 'Invalid activity category' } }, 400)
    const limit = parseLimit(c.req.query('limit'))
    if (limit === null) return c.json({ error: { code: 'INVALID_LIMIT', message: 'limit must be an integer between 1 and 200' } }, 400)
    const data = await repo.listActivity({ organizationId, eventId, ...(category?.success ? { category: category.data } : {}), limit })
    return c.json({ data: data.map(serializeActivity) })
  })

  app.get('/api/v1/inbox', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const statusRaw = c.req.query('status')
    const severityRaw = c.req.query('severity')
    const eventId = c.req.query('eventId')
    const status = statusRaw ? z.enum(INBOX_STATUSES).safeParse(statusRaw) : null
    const severity = severityRaw ? z.enum(INBOX_SEVERITIES).safeParse(severityRaw) : null
    if (statusRaw && !status?.success) return c.json({ error: { code: 'INVALID_STATUS', message: 'Invalid inbox status' } }, 400)
    if (severityRaw && !severity?.success) return c.json({ error: { code: 'INVALID_SEVERITY', message: 'Invalid inbox severity' } }, 400)
    if (eventId && !z.uuid().safeParse(eventId).success) return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'eventId must be a UUID' } }, 400)
    const limit = parseLimit(c.req.query('limit'))
    if (limit === null) return c.json({ error: { code: 'INVALID_LIMIT', message: 'limit must be an integer between 1 and 200' } }, 400)
    const data = await repo.listInbox({ organizationId, ...(status?.success ? { status: status.data } : {}), ...(severity?.success ? { severity: severity.data } : {}), ...(eventId ? { eventId } : {}), limit })
    return c.json({ data: data.map(serializeInbox) })
  })

  app.get('/api/v1/inbox/:itemId', async (c) => {
    const organizationId = await resolveOrganizationId(c, organizations)
    if (typeof organizationId !== 'string') return organizationId
    const itemId = c.req.param('itemId')
    if (!z.uuid().safeParse(itemId).success) return c.json({ error: { code: 'INVALID_INBOX_ITEM_ID', message: 'Inbox item id must be a UUID' } }, 400)
    const item = await repo.findInboxItem(organizationId, itemId)
    return item ? c.json({ data: serializeInbox(item) }) : c.json({ error: { code: 'INBOX_ITEM_NOT_FOUND', message: 'Inbox item not found' } }, 404)
  })

  app.post('/api/v1/inbox/:itemId/resolve', async (c) => mutateInbox(c, organizations, repo, 'resolve'))
  app.post('/api/v1/inbox/:itemId/dismiss', async (c) => mutateInbox(c, organizations, repo, 'dismiss'))
}

async function mutateInbox(c: any, organizations: OrganizationRepository, repo: OperationalRepository, action: 'resolve' | 'dismiss') {
  const organizationId = await resolveOrganizationId(c, organizations)
  if (typeof organizationId !== 'string') return organizationId
  const itemId = c.req.param('itemId')
  if (!z.uuid().safeParse(itemId).success) return c.json({ error: { code: 'INVALID_INBOX_ITEM_ID', message: 'Inbox item id must be a UUID' } }, 400)
  const item = action === 'resolve' ? await repo.resolveInboxItem(organizationId, itemId) : await repo.dismissInboxItem(organizationId, itemId)
  return item ? c.json({ data: serializeInbox(item) }) : c.json({ error: { code: 'INBOX_ITEM_NOT_FOUND', message: 'Inbox item not found' } }, 404)
}

async function resolveOrganizationId(c: any, organizations: OrganizationRepository): Promise<string | any> {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId) return c.json({ error: { code: 'ORGANIZATION_REQUIRED', message: 'x-organization-id header is required' } }, 400)
  if (!z.uuid().safeParse(organizationId).success) return c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'x-organization-id must be a UUID' } }, 400)
  if (!(await organizations.exists(organizationId))) return c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404)
  return organizationId
}
function parseLimit(value: string | undefined): number | null {
  if (!value) return 50
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : null
}
function serializeActivity(value: ActivityEntry) { return { ...value, occurredAt: value.occurredAt.toISOString(), createdAt: value.createdAt.toISOString() } }
function serializeInbox(value: InboxItem) { return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), resolvedAt: value.resolvedAt?.toISOString() ?? null } }
