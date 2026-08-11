import type { Hono } from 'hono'
import type { MessagingEngine } from '@ecc/event-engine'
import {
  AutomationActionNotFoundError,
  MessageSendInProgressError,
  MessagingProviderError,
  MessagingValidationError,
  OutboundMessageNotFoundError,
} from '@ecc/domain'

export function registerMessagingRoutes(app: Hono, engine: MessagingEngine): void {
  app.post('/api/v1/internal/automation-actions/:actionId/outbound-message', async (c) => {
    try {
      const result = await engine.prepareVendorConfirmation(c.req.param('actionId'))
      return c.json({ message: serialize(result.message), duplicate: !result.created }, result.created ? 201 : 200)
    } catch (error) { return mapError(c, error) }
  })

  app.post('/api/v1/internal/outbound-messages/:messageId/send', async (c) => {
    try {
      const result = await engine.send(c.req.param('messageId'))
      return c.json({ message: serialize(result.message), duplicate: result.duplicate })
    } catch (error) { return mapError(c, error) }
  })

  app.get('/api/v1/internal/outbound-messages/:messageId', async (c) => {
    const message = await engine.getMessage(c.req.param('messageId'))
    return message ? c.json({ message: serialize(message) }) : c.json({ error: { code: 'OUTBOUND_MESSAGE_NOT_FOUND', message: 'Outbound message not found' } }, 404)
  })
}

function serialize(message: any) {
  return {
    ...message,
    createdAt: message.createdAt.toISOString(), updatedAt: message.updatedAt.toISOString(),
    sentAt: message.sentAt?.toISOString() ?? null, deliveredAt: message.deliveredAt?.toISOString() ?? null,
    readAt: message.readAt?.toISOString() ?? null, failedAt: message.failedAt?.toISOString() ?? null,
  }
}

function mapError(c: any, error: unknown) {
  if (error instanceof AutomationActionNotFoundError || error instanceof OutboundMessageNotFoundError) {
    return c.json({ error: { code: error.code, message: error.message } }, 404)
  }
  if (error instanceof MessagingValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  if (error instanceof MessageSendInProgressError) return c.json({ error: { code: error.code, message: error.message } }, 409)
  if (error instanceof MessagingProviderError) return c.json({ error: { code: error.code, message: error.message } }, 502)
  throw error
}
