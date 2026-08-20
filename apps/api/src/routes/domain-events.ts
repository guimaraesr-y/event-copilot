import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { canonicalizeDomainEvent, domainEventEnvelopeSchema, type DomainEventEnvelope } from '@ecc/contracts'
import type { DomainEventGatewayRepository } from '@ecc/database'

const MAX_SIGNATURE_AGE_SECONDS = 300
const VENDOR_CONFIRMATION_ACTION = 'vendor_confirmation.prepare'
const DAILY_BRIEF_ACTION = 'daily_brief.prepare'

export function registerDomainEventRoutes(app: Hono, repository: DomainEventGatewayRepository): void {
  app.post('/api/v1/internal/domain-events/verify', async (c) => {
    const parsed = domainEventEnvelopeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'INVALID_DOMAIN_EVENT', message: 'Invalid domain event envelope' } }, 400)

    const authError = verifySignature(c.req.header('x-ecc-timestamp'), c.req.header('x-ecc-signature'), parsed.data)
    if (authError) return c.json({ error: { code: 'INVALID_DOMAIN_EVENT_SIGNATURE', message: authError } }, 401)

    if (!(await repository.matchesOutbox(parsed.data))) {
      return c.json({ error: { code: 'UNKNOWN_DOMAIN_EVENT', message: 'Domain event does not match the transactional outbox' } }, 404)
    }

    return c.json({ accepted: true, id: parsed.data.id, eventType: parsed.data.eventType })
  })

  app.post('/api/v1/internal/automations/vendor-confirmation-requested', async (c) => {
    const parsed = domainEventEnvelopeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'INVALID_DOMAIN_EVENT', message: 'Invalid domain event envelope' } }, 400)

    const authError = verifySignature(c.req.header('x-ecc-timestamp'), c.req.header('x-ecc-signature'), parsed.data)
    if (authError) return c.json({ error: { code: 'INVALID_DOMAIN_EVENT_SIGNATURE', message: authError } }, 401)

    if (parsed.data.eventType !== 'vendor.confirmation_requested') {
      return c.json({ error: { code: 'UNSUPPORTED_DOMAIN_EVENT', message: 'Expected vendor.confirmation_requested' } }, 422)
    }

    if (!(await repository.matchesOutbox(parsed.data))) {
      return c.json({ error: { code: 'UNKNOWN_DOMAIN_EVENT', message: 'Domain event does not match the transactional outbox' } }, 404)
    }

    const result = await repository.prepareAction(parsed.data, VENDOR_CONFIRMATION_ACTION)
    return c.json({
      accepted: true,
      actionId: result.action.id,
      actionType: result.action.actionType,
      status: result.action.status,
      duplicate: !result.created,
    })
  })
  app.post('/api/v1/internal/automations/daily-brief-delivery-requested', async (c) => {
    const parsed = domainEventEnvelopeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: { code: 'INVALID_DOMAIN_EVENT', message: 'Invalid domain event envelope' } }, 400)
    const authError = verifySignature(c.req.header('x-ecc-timestamp'), c.req.header('x-ecc-signature'), parsed.data)
    if (authError) return c.json({ error: { code: 'INVALID_DOMAIN_EVENT_SIGNATURE', message: authError } }, 401)
    if (parsed.data.eventType !== 'brief.delivery_requested') return c.json({ error: { code: 'UNSUPPORTED_DOMAIN_EVENT', message: 'Expected brief.delivery_requested' } }, 422)
    if (!(await repository.matchesOutbox(parsed.data))) return c.json({ error: { code: 'UNKNOWN_DOMAIN_EVENT', message: 'Domain event does not match the transactional outbox' } }, 404)
    const result = await repository.prepareAction(parsed.data, DAILY_BRIEF_ACTION)
    return c.json({ accepted: true, actionId: result.action.id, actionType: result.action.actionType, status: result.action.status, duplicate: !result.created })
  })

}

function verifySignature(timestampHeader: string | undefined, signatureHeader: string | undefined, envelope: DomainEventEnvelope): string | null {
  const secret = process.env.DOMAIN_EVENT_SHARED_SECRET
  if (!secret || secret.length < 32) return 'DOMAIN_EVENT_SHARED_SECRET must contain at least 32 characters'
  if (!timestampHeader || !/^\d+$/.test(timestampHeader)) return 'Missing or invalid x-ecc-timestamp'
  if (!signatureHeader?.startsWith('sha256=')) return 'Missing or invalid x-ecc-signature'

  const timestamp = Number(timestampHeader)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_SECONDS) return 'Domain event signature has expired'

  const expectedHex = createHmac('sha256', secret)
    .update(`${timestampHeader}.${canonicalizeDomainEvent(envelope)}`)
    .digest('hex')
  const providedHex = signatureHeader.slice('sha256='.length)
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return 'Invalid domain event signature'

  const expected = Buffer.from(expectedHex, 'hex')
  const provided = Buffer.from(providedHex, 'hex')
  return expected.length === provided.length && timingSafeEqual(expected, provided) ? null : 'Invalid domain event signature'
}
