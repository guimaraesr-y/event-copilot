import type { Hono } from 'hono'
import { z } from 'zod'
import { createChangeProposalSchema, decideChangeProposalSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import { ChangeProposalConflictError, ChangeProposalNotFoundError, ChangeProposalValidationError, type ChangeProposalWithImpacts } from '@ecc/domain'
import type { ChangeProposalEngine } from '@ecc/event-engine'

export function registerChangeProposalRoutes(app: Hono, organizations: OrganizationRepository, engine: ChangeProposalEngine): void {
  app.post('/api/v1/events/:eventId/change-proposals', async (c) => {
    const ctx = await organizationContext(c, organizations)
    if ('response' in ctx) return ctx.response
    const eventId = c.req.param('eventId')
    if (!z.uuid().safeParse(eventId).success) return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'eventId must be a UUID' } }, 400)
    const parsed = createChangeProposalSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid change proposal payload', issues: parsed.error.issues } }, 400)
    try {
      const result = await engine.create({ organizationId: ctx.organization.id, organizationTimezone: ctx.organization.timezone, eventId, requestedBySender: parsed.data.sender, idempotencyKey: parsed.data.idempotencyKey, type: parsed.data.type, proposedValue: parsed.data.proposedValue, reason: parsed.data.reason })
      return c.json({ data: serializeResult(result) }, result.duplicate ? 200 : 201)
    } catch (error) { return mapError(c, error) }
  })

  app.get('/api/v1/change-proposals', async (c) => {
    const ctx = await organizationContext(c, organizations)
    if ('response' in ctx) return ctx.response
    const eventId = c.req.query('eventId')?.trim()
    const status = c.req.query('status')?.trim()
    if (eventId && !z.uuid().safeParse(eventId).success) return c.json({ error: { code: 'INVALID_EVENT_ID', message: 'eventId must be a UUID' } }, 400)
    if (status && !['proposed','applied','rejected','cancelled'].includes(status)) return c.json({ error: { code: 'INVALID_STATUS', message: 'Unsupported proposal status' } }, 400)
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const values = await engine.list({ organizationId: ctx.organization.id, ...(eventId ? { eventId } : {}), ...(status ? { status: status as any } : {}), limit })
    return c.json({ data: values.map(serializeValue) })
  })

  app.get('/api/v1/change-proposals/:id', async (c) => {
    const ctx = await organizationContext(c, organizations)
    if ('response' in ctx) return ctx.response
    const id = c.req.param('id')
    if (!z.uuid().safeParse(id).success) return c.json({ error: { code: 'INVALID_CHANGE_PROPOSAL_ID', message: 'id must be a UUID' } }, 400)
    try { return c.json({ data: serializeValue(await engine.get(ctx.organization.id, id)) }) } catch (error) { return mapError(c, error) }
  })

  app.post('/api/v1/change-proposals/:id/approve', async (c) => {
    const ctx = await organizationContext(c, organizations)
    if ('response' in ctx) return ctx.response
    const id = c.req.param('id')
    if (!z.uuid().safeParse(id).success) return c.json({ error: { code: 'INVALID_CHANGE_PROPOSAL_ID', message: 'id must be a UUID' } }, 400)
    const parsed = decideChangeProposalSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval payload', issues: parsed.error.issues } }, 400)
    try {
      const result = await engine.approve({ organizationId: ctx.organization.id, organizationTimezone: ctx.organization.timezone, proposalId: id, decidedBySender: parsed.data.sender })
      return c.json({ data: serializeResult(result) })
    } catch (error) { return mapError(c, error) }
  })

  app.post('/api/v1/change-proposals/:id/reject', async (c) => {
    const ctx = await organizationContext(c, organizations)
    if ('response' in ctx) return ctx.response
    const id = c.req.param('id')
    if (!z.uuid().safeParse(id).success) return c.json({ error: { code: 'INVALID_CHANGE_PROPOSAL_ID', message: 'id must be a UUID' } }, 400)
    const parsed = decideChangeProposalSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid rejection payload', issues: parsed.error.issues } }, 400)
    try {
      const result = await engine.reject({ organizationId: ctx.organization.id, proposalId: id, decidedBySender: parsed.data.sender, reason: parsed.data.reason })
      return c.json({ data: serializeResult(result) })
    } catch (error) { return mapError(c, error) }
  })
}

async function organizationContext(c: any, organizations: OrganizationRepository): Promise<any> {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId || !z.uuid().safeParse(organizationId).success) return { response: c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'A valid x-organization-id is required' } }, 400) }
  const organization = await organizations.findById(organizationId)
  return organization ? { organization } : { response: c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404) }
}
function mapError(c: any, error: unknown) {
  if (error instanceof ChangeProposalNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404)
  if (error instanceof ChangeProposalConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409)
  if (error instanceof ChangeProposalValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  throw error
}
function serializeValue(value: ChangeProposalWithImpacts) { return { proposal: serializeProposal(value.proposal), impacts: value.impacts.map((impact) => ({ ...impact, createdAt: impact.createdAt.toISOString() })) } }
function serializeResult(result: any) { return { ...serializeValue(result), duplicate: result.duplicate, reply: result.reply } }
function serializeProposal(p: any) { return { ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), decidedAt: p.decidedAt?.toISOString() ?? null, appliedAt: p.appliedAt?.toISOString() ?? null } }
