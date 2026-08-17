import type { Hono } from 'hono'
import { z } from 'zod'
import { operationalAgentMessageSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import {
  OperationalAgentConflictError,
  OperationalAgentLoopError,
  OperationalAgentProviderError,
  OperationalAgentValidationError,
} from '@ecc/domain'
import type { OperationalAgent } from '@ecc/event-engine'

export function registerOperationalAgentRoutes(app: Hono, organizations: OrganizationRepository, agent: OperationalAgent): void {
  app.post('/api/v1/agent/messages', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const body = await c.req.json().catch(() => null)
    const parsed = operationalAgentMessageSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid operational agent payload', issues: parsed.error.issues } }, 400)

    try {
      const result = await agent.chat({
        organizationId: context.organization.id,
        organizationTimezone: context.organization.timezone,
        sender: parsed.data.sender,
        text: parsed.data.text,
        idempotencyKey: parsed.data.idempotencyKey,
        explicitEventId: parsed.data.eventId ?? null,
      })
      return c.json({ data: { turn: serializeTurn(result.turn), duplicate: result.duplicate, reply: result.reply } }, result.duplicate ? 200 : 201)
    } catch (error) { return mapError(c, error) }
  })

  app.get('/api/v1/agent/history', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const sender = c.req.query('sender')?.trim()
    if (!sender) return c.json({ error: { code: 'SENDER_REQUIRED', message: 'sender query parameter is required' } }, 400)
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '10', 10)
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : 10
    const turns = await agent.history(context.organization.id, sender, limit)
    return c.json({ data: turns.map(serializeTurn) })
  })
}

async function organizationContext(c: any, organizations: OrganizationRepository): Promise<any> {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId || !z.uuid().safeParse(organizationId).success) {
    return { response: c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'A valid x-organization-id is required' } }, 400) }
  }
  const organization = await organizations.findById(organizationId)
  if (!organization) return { response: c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404) }
  return { organization }
}

function serializeTurn(turn: any) {
  return {
    ...turn,
    createdAt: turn.createdAt.toISOString(),
    updatedAt: turn.updatedAt.toISOString(),
    completedAt: turn.completedAt?.toISOString() ?? null,
  }
}
function mapError(c: any, error: unknown) {
  if (error instanceof OperationalAgentConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409)
  if (error instanceof OperationalAgentValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  if (error instanceof OperationalAgentProviderError) return c.json({ error: { code: error.code, message: error.message } }, 502)
  if (error instanceof OperationalAgentLoopError) return c.json({ error: { code: error.code, message: error.message } }, 502)
  throw error
}
