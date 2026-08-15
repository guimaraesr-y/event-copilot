import type { Hono } from 'hono'
import { z } from 'zod'
import { executeCommandSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import { CommandInterpreterError, CommandRequestNotFoundError, CommandValidationError } from '@ecc/domain'
import type { CommandEngine } from '@ecc/event-engine'

export function registerCommandRoutes(app: Hono, organizations: OrganizationRepository, engine: CommandEngine): void {
  app.post('/api/v1/commands', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const body = await c.req.json().catch(() => null)
    const parsed = executeCommandSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid command payload', issues: parsed.error.issues } }, 400)

    try {
      const result = await engine.execute({
        organizationId: context.organization.id,
        organizationTimezone: context.organization.timezone,
        sender: parsed.data.sender,
        text: parsed.data.text,
        idempotencyKey: parsed.data.idempotencyKey,
        explicitEventId: parsed.data.eventId ?? null,
      })
      return c.json({ data: serializeExecution(result) }, result.duplicate ? 200 : 201)
    } catch (error) { return mapError(c, error) }
  })

  app.get('/api/v1/commands/:requestId', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const requestId = c.req.param('requestId')
    if (!z.uuid().safeParse(requestId).success) return c.json({ error: { code: 'INVALID_COMMAND_ID', message: 'Command request id must be a UUID' } }, 400)
    try { return c.json({ data: serializeRequest(await engine.findRequest(context.organization.id, requestId)) }) }
    catch (error) { return mapError(c, error) }
  })

  app.get('/api/v1/command-context', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const sender = c.req.query('sender')?.trim()
    if (!sender) return c.json({ error: { code: 'SENDER_REQUIRED', message: 'sender query parameter is required' } }, 400)
    const current = await engine.getContext(context.organization.id, sender)
    return c.json({ data: current ? {
      ...current,
      lastInteractionAt: current.lastInteractionAt.toISOString(),
      createdAt: current.createdAt.toISOString(),
      updatedAt: current.updatedAt.toISOString(),
    } : null })
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
function serializeExecution(result: any) {
  return { request: serializeRequest(result.request), duplicate: result.duplicate, reply: result.reply, result: result.result }
}
function serializeRequest(request: any) {
  return {
    ...request,
    createdAt: request.createdAt.toISOString(), updatedAt: request.updatedAt.toISOString(), processedAt: request.processedAt?.toISOString() ?? null,
  }
}
function mapError(c: any, error: unknown) {
  if (error instanceof CommandRequestNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404)
  if (error instanceof CommandValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  if (error instanceof CommandInterpreterError) return c.json({ error: { code: error.code, message: error.message } }, 502)
  throw error
}
