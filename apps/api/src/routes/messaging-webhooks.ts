import type { Hono } from 'hono'
import type { MessageProviderName } from '@ecc/domain'
import type { MessagingEngine } from '@ecc/event-engine'
import {
  MessagingWebhookPayloadError,
  MessagingWebhookVerificationError,
  rawPayloadHash,
  type MessagingWebhookAdapter,
} from '@ecc/messaging'

export function registerMessagingWebhookRoutes(
  app: Hono,
  engine: MessagingEngine,
  registry: Map<MessageProviderName, MessagingWebhookAdapter>,
): void {
  app.get('/api/v1/messaging/webhooks/:provider', async (c) => {
    const adapter = resolveAdapter(registry, c.req.param('provider'))
    if (!adapter) return c.json({ error: { code: 'UNKNOWN_MESSAGING_PROVIDER', message: 'Unknown messaging webhook provider' } }, 404)
    if (!adapter.challenge) return c.json({ error: { code: 'WEBHOOK_CHALLENGE_NOT_SUPPORTED', message: 'Provider does not use GET webhook verification' } }, 405)
    try {
      const challenge = adapter.challenge(c.req.query())
      return challenge === null
        ? c.json({ error: { code: 'INVALID_WEBHOOK_CHALLENGE', message: 'Webhook verification failed' } }, 403)
        : c.text(challenge, 200)
    } catch (error) { return mapWebhookError(c, error) }
  })

  app.post('/api/v1/messaging/webhooks/:provider', async (c) => {
    const adapter = resolveAdapter(registry, c.req.param('provider'))
    if (!adapter) return c.json({ error: { code: 'UNKNOWN_MESSAGING_PROVIDER', message: 'Unknown messaging webhook provider' } }, 404)

    const rawBody = await c.req.text()
    const headers = headersRecord(c.req.raw.headers)
    const receivedAt = new Date()
    try {
      adapter.verify({ rawBody, headers, query: c.req.query(), receivedAt })
      const events = adapter.parse({ rawBody, headers, query: c.req.query(), receivedAt })
      const rawPayload = parseRootObject(rawBody)
      const payloadHash = rawPayloadHash(rawBody)
      const results = []
      for (const event of events) {
        results.push(await engine.handleWebhookEvent({ event, payloadHash, rawPayload, receivedAt }))
      }
      return c.json({ accepted: true, provider: adapter.provider, events: events.length, results })
    } catch (error) { return mapWebhookError(c, error) }
  })
}

function resolveAdapter(registry: Map<MessageProviderName, MessagingWebhookAdapter>, value: string): MessagingWebhookAdapter | null {
  if (value !== 'mock' && value !== 'meta') return null
  return registry.get(value) ?? null
}

function headersRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => { result[key.toLowerCase()] = value })
  return result
}

function parseRootObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function mapWebhookError(c: any, error: unknown) {
  if (error instanceof MessagingWebhookVerificationError) return c.json({ error: { code: error.code, message: error.message } }, 401)
  if (error instanceof MessagingWebhookPayloadError) return c.json({ error: { code: error.code, message: error.message } }, 400)
  throw error
}
