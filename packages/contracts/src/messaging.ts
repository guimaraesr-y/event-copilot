import { z } from 'zod'

export const providerStatusSchema = z.object({
  provider: z.enum(['mock', 'meta']),
  externalMessageId: z.string().trim().min(1).max(255),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  occurredAt: z.iso.datetime({ offset: true }),
  raw: z.record(z.string(), z.unknown()).optional(),
})
export type ProviderStatusPayload = z.infer<typeof providerStatusSchema>

export function canonicalizeProviderStatus(payload: ProviderStatusPayload): string {
  return stableStringify(payload)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
