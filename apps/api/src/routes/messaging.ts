import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { canonicalizeProviderStatus, providerStatusSchema, type ProviderStatusPayload } from '@ecc/contracts'
import type { MessagingEngine } from '@ecc/event-engine'
import {
  AutomationActionNotFoundError,
  MessageSendInProgressError,
  MessagingProviderError,
  MessagingValidationError,
  OutboundMessageNotFoundError,
} from '@ecc/domain'

const MAX_SIGNATURE_AGE_SECONDS = 300

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

  app.post('/api/v1/internal/outbound-messages/provider-status', async (c) => {
    const parsed = providerStatusSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'INVALID_PROVIDER_STATUS', message: 'Invalid provider status payload' } }, 400)
    const authError = verifyProviderSignature(c.req.header('x-ecc-timestamp'), c.req.header('x-ecc-signature'), parsed.data)
    if (authError) return c.json({ error: { code: 'INVALID_PROVIDER_SIGNATURE', message: authError } }, 401)
    try {
      const result = await engine.applyProviderStatus({ ...parsed.data, occurredAt: new Date(parsed.data.occurredAt) })
      return c.json({ message: serialize(result.message), duplicate: !result.changed })
    } catch (error) { return mapError(c, error) }
  })
}

function verifyProviderSignature(timestampHeader: string | undefined, signatureHeader: string | undefined, payload: ProviderStatusPayload): string | null {
  const secret = process.env.MESSAGING_WEBHOOK_SHARED_SECRET
  if (!secret || secret.length < 32) return 'MESSAGING_WEBHOOK_SHARED_SECRET must contain at least 32 characters'
  if (!timestampHeader || !/^\d+$/.test(timestampHeader)) return 'Missing or invalid x-ecc-timestamp'
  if (!signatureHeader?.startsWith('sha256=')) return 'Missing or invalid x-ecc-signature'
  const timestamp = Number(timestampHeader)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_SECONDS) return 'Provider status signature has expired'
  const expectedHex = createHmac('sha256', secret).update(`${timestampHeader}.${canonicalizeProviderStatus(payload)}`).digest('hex')
  const providedHex = signatureHeader.slice('sha256='.length)
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return 'Invalid provider status signature'
  const expected = Buffer.from(expectedHex, 'hex')
  const provided = Buffer.from(providedHex, 'hex')
  return expected.length === provided.length && timingSafeEqual(expected, provided) ? null : 'Invalid provider status signature'
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
