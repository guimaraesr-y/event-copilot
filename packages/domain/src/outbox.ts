export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  organizationId: string
  eventType: string
  aggregateType: string
  aggregateId: string
  occurredAt: Date
  payload: TPayload
}

export interface OutboxMessage extends DomainEvent {
  attempts: number
  availableAt: Date
  claimedAt: Date | null
  claimedBy: string | null
  dispatchedAt: Date | null
  lastError: string | null
}
