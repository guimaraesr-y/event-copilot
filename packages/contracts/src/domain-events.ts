import { z } from 'zod'

export const domainEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  organizationId: z.uuid(),
  eventType: z.string().trim().min(1).max(120),
  aggregateType: z.string().trim().min(1).max(120),
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
})

export type DomainEventEnvelope = z.infer<typeof domainEventEnvelopeSchema>

export function canonicalizeDomainEvent(envelope: DomainEventEnvelope): string {
  return stableStringify(envelope)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}
