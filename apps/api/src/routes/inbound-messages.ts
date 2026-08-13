import type { Hono } from 'hono'
import type { InboundEngine } from '@ecc/event-engine'
import { InboundMessageNotFoundError, VendorValidationError, EventVendorNotFoundError } from '@ecc/domain'

export function registerInboundMessageRoutes(app: Hono, engine: InboundEngine): void {
  app.post('/api/v1/internal/inbound-messages/:messageId/process', async (c) => {
    try {
      const result = await engine.process(c.req.param('messageId'))
      return c.json({
        message: serialize(result.message),
        duplicate: result.duplicate,
        action: result.action,
      })
    } catch (error) { return mapError(c, error) }
  })
}

function serialize(message: any) {
  return {
    ...message,
    receivedAt: message.receivedAt.toISOString(),
    processedAt: message.processedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  }
}

function mapError(c: any, error: unknown) {
  if (error instanceof InboundMessageNotFoundError || error instanceof EventVendorNotFoundError) {
    return c.json({ error: { code: error.code, message: error.message } }, 404)
  }
  if (error instanceof VendorValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  throw error
}
