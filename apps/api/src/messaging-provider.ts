import type { MessagingProvider, OutboundMessage, SendResult } from '@ecc/domain'
import { MessagingProviderError } from '@ecc/domain'

export function createMessagingProvider(): MessagingProvider {
  const provider = (process.env.WHATSAPP_PROVIDER ?? 'mock').toLowerCase()
  if (provider === 'mock') return new MockWhatsAppProvider()
  if (provider === 'meta') return new MetaWhatsAppProvider()
  throw new Error(`Unsupported WHATSAPP_PROVIDER: ${provider}`)
}

class MockWhatsAppProvider implements MessagingProvider {
  readonly name = 'mock' as const

  async send(message: OutboundMessage): Promise<SendResult> {
    return {
      externalMessageId: `mock-wamid-${message.id}`,
      providerResponse: { mock: true, accepted: true, recipient: message.recipient },
    }
  }
}

class MetaWhatsAppProvider implements MessagingProvider {
  readonly name = 'meta' as const

  async send(message: OutboundMessage): Promise<SendResult> {
    const token = required('WHATSAPP_ACCESS_TOKEN')
    const phoneNumberId = required('WHATSAPP_PHONE_NUMBER_ID')
    const version = required('META_GRAPH_API_VERSION')
    const baseUrl = (process.env.META_GRAPH_API_BASE_URL ?? 'https://graph.facebook.com').replace(/\/$/, '')
    const text = typeof message.payload.text === 'string' ? message.payload.text : null
    if (!text) throw new MessagingProviderError('Outbound WhatsApp message is missing payload.text')

    const response = await fetch(`${baseUrl}/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: message.recipient, type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json().catch(() => ({})) as Record<string, any>
    if (!response.ok) throw new MessagingProviderError(`Meta WhatsApp returned ${response.status}: ${JSON.stringify(body).slice(0, 500)}`)
    const externalMessageId = body.messages?.[0]?.id
    if (typeof externalMessageId !== 'string' || !externalMessageId) throw new MessagingProviderError('Meta WhatsApp response did not contain messages[0].id')
    return { externalMessageId, providerResponse: body }
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new MessagingProviderError(`${name} is required when WHATSAPP_PROVIDER=meta`)
  return value
}
