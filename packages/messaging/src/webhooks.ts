import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type {
  CanonicalMessagingWebhookEvent,
  MessageProviderName,
  ProviderMessageStatus,
} from '@ecc/domain'

export interface MessagingWebhookRequest {
  rawBody: string
  headers: Record<string, string | undefined>
  query: Record<string, string | undefined>
  receivedAt: Date
}

export interface MessagingWebhookAdapter {
  readonly provider: MessageProviderName
  verify(request: MessagingWebhookRequest): void
  parse(request: MessagingWebhookRequest): CanonicalMessagingWebhookEvent[]
  challenge?(query: Record<string, string | undefined>): string | null
}

export class MessagingWebhookVerificationError extends Error {
  readonly code = 'MESSAGING_WEBHOOK_VERIFICATION_ERROR'
  constructor(message: string) { super(message); this.name = 'MessagingWebhookVerificationError' }
}

export class MessagingWebhookPayloadError extends Error {
  readonly code = 'MESSAGING_WEBHOOK_PAYLOAD_ERROR'
  constructor(message: string) { super(message); this.name = 'MessagingWebhookPayloadError' }
}

export function createMessagingWebhookRegistry(): Map<MessageProviderName, MessagingWebhookAdapter> {
  return new Map<MessageProviderName, MessagingWebhookAdapter>([
    ['mock', new MockMessagingWebhookAdapter(requiredSecret('MESSAGING_WEBHOOK_SHARED_SECRET'))],
    ['meta', new MetaWhatsAppWebhookAdapter({
      appSecret: process.env.META_APP_SECRET?.trim() ?? '',
      verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() ?? '',
    })],
  ])
}

export class MockMessagingWebhookAdapter implements MessagingWebhookAdapter {
  readonly provider = 'mock' as const
  constructor(private readonly secret: string) {}

  verify(request: MessagingWebhookRequest): void {
    const timestamp = request.headers['x-ecc-timestamp']
    const signature = request.headers['x-ecc-signature']
    if (!timestamp || !/^\d+$/.test(timestamp)) throw new MessagingWebhookVerificationError('Missing or invalid x-ecc-timestamp')
    const now = Math.floor(request.receivedAt.getTime() / 1000)
    if (Math.abs(now - Number(timestamp)) > 300) throw new MessagingWebhookVerificationError('Mock webhook signature has expired')
    if (!signature?.startsWith('sha256=')) throw new MessagingWebhookVerificationError('Missing or invalid x-ecc-signature')
    verifyHexHmac('sha256', this.secret, `${timestamp}.${request.rawBody}`, signature.slice(7))
  }

  parse(request: MessagingWebhookRequest): CanonicalMessagingWebhookEvent[] {
    const body = jsonObject(request.rawBody)
    const externalMessageId = stringField(body.externalMessageId, 'externalMessageId')
    const occurredAt = dateField(body.occurredAt, 'occurredAt')
    if (body.type === 'message.received') {
      const sender = stringField(body.sender, 'sender')
      const recipient = typeof body.recipient === 'string' ? body.recipient : null
      const content = isRecord(body.content) && body.content.type === 'text' && typeof body.content.text === 'string'
        ? { type: 'text' as const, text: body.content.text }
        : { type: 'media' as const, mediaType: 'unknown', mediaId: null, caption: null }
      return [{
        type: 'message.received', provider: 'mock', externalEventId: `mock:${externalMessageId}:received`,
        externalMessageId, sender, recipient, occurredAt, content, raw: body,
      }]
    }
    const status = providerStatus(body.status)
    return [{
      type: 'message.status', provider: 'mock',
      externalEventId: `mock:${externalMessageId}:${status}:${occurredAt.toISOString()}`,
      externalMessageId, status, occurredAt, raw: body,
    }]
  }
}

export class MetaWhatsAppWebhookAdapter implements MessagingWebhookAdapter {
  readonly provider = 'meta' as const
  constructor(private readonly config: { appSecret: string; verifyToken: string }) {}

  challenge(query: Record<string, string | undefined>): string | null {
    if (!this.config.verifyToken) throw new MessagingWebhookVerificationError('META_WEBHOOK_VERIFY_TOKEN is not configured')
    if (query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== this.config.verifyToken) return null
    return query['hub.challenge'] ?? null
  }

  verify(request: MessagingWebhookRequest): void {
    if (!this.config.appSecret) throw new MessagingWebhookVerificationError('META_APP_SECRET is not configured')
    const signature = request.headers['x-hub-signature-256']
    if (!signature?.startsWith('sha256=')) throw new MessagingWebhookVerificationError('Missing or invalid x-hub-signature-256')
    verifyHexHmac('sha256', this.config.appSecret, request.rawBody, signature.slice(7))
  }

  parse(request: MessagingWebhookRequest): CanonicalMessagingWebhookEvent[] {
    const body = jsonObject(request.rawBody)
    const events: CanonicalMessagingWebhookEvent[] = []
    const entries = Array.isArray(body.entry) ? body.entry : []
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const changes = Array.isArray(entry.changes) ? entry.changes : []
      for (const change of changes) {
        if (!isRecord(change) || !isRecord(change.value)) continue
        const value = change.value
        const statuses = Array.isArray(value.statuses) ? value.statuses : []
        for (const item of statuses) {
          if (!isRecord(item) || typeof item.id !== 'string' || typeof item.status !== 'string') continue
          const status = metaStatus(item.status)
          if (!status) continue
          const occurredAt = unixSecondsDate(item.timestamp, request.receivedAt)
          events.push({
            type: 'message.status', provider: 'meta',
            externalEventId: `meta:${item.id}:${status}:${occurredAt.toISOString()}`,
            externalMessageId: item.id, status, occurredAt, raw: item,
          })
        }
        const messages = Array.isArray(value.messages) ? value.messages : []
        for (const message of messages) {
          if (!isRecord(message) || typeof message.id !== 'string' || typeof message.from !== 'string') continue
          const occurredAt = unixSecondsDate(message.timestamp, request.receivedAt)
          events.push({
            type: 'message.received', provider: 'meta', externalEventId: `meta:${message.id}:received`,
            externalMessageId: message.id, sender: message.from, recipient: metaRecipient(value), occurredAt,
            content: metaContent(message), raw: message,
          })
        }
      }
    }
    return events
  }
}


export function rawPayloadHash(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex')
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim() ?? ''
  if (value.length < 32) throw new MessagingWebhookVerificationError(`${name} must contain at least 32 characters`)
  return value
}

function verifyHexHmac(algorithm: 'sha256', secret: string, body: string, providedHex: string): void {
  const expectedHex = createHmac(algorithm, secret).update(body).digest('hex')
  if (!/^[a-f0-9]+$/i.test(providedHex) || providedHex.length !== expectedHex.length) throw new MessagingWebhookVerificationError('Invalid webhook signature')
  const expected = Buffer.from(expectedHex, 'hex')
  const provided = Buffer.from(providedHex, 'hex')
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new MessagingWebhookVerificationError('Invalid webhook signature')
}

function jsonObject(rawBody: string): Record<string, any> {
  try { const value = JSON.parse(rawBody); if (isRecord(value)) return value } catch {}
  throw new MessagingWebhookPayloadError('Webhook body must be a JSON object')
}
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function stringField(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new MessagingWebhookPayloadError(`${name} is required`); return value.trim() }
function dateField(value: unknown, name: string): Date { const date = new Date(typeof value === 'string' ? value : ''); if (Number.isNaN(date.getTime())) throw new MessagingWebhookPayloadError(`${name} must be a valid date`); return date }
function unixSecondsDate(value: unknown, fallback: Date): Date { const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(seconds) ? new Date(seconds * 1000) : fallback }
function providerStatus(value: unknown): ProviderMessageStatus { if (value === 'sent' || value === 'delivered' || value === 'read' || value === 'failed') return value; throw new MessagingWebhookPayloadError('status is invalid') }
function metaStatus(value: string): ProviderMessageStatus | null { return value === 'sent' || value === 'delivered' || value === 'read' || value === 'failed' ? value : null }
function metaRecipient(value: Record<string, any>): string | null { const phone = value.metadata?.display_phone_number ?? value.metadata?.phone_number_id; return typeof phone === 'string' ? phone : null }
function metaContent(message: Record<string, any>) { if (message.type === 'text' && typeof message.text?.body === 'string') return { type: 'text' as const, text: message.text.body }; const media = isRecord(message[message.type]) ? message[message.type] : {}; return { type: 'media' as const, mediaType: typeof message.type === 'string' ? message.type : 'unknown', mediaId: typeof media.id === 'string' ? media.id : null, caption: typeof media.caption === 'string' ? media.caption : null } }
