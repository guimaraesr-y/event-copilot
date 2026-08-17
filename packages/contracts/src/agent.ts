import { z } from 'zod'

export const operationalAgentMessageSchema = z.object({
  sender: z.string().trim().min(2).max(128),
  text: z.string().trim().min(2).max(8000),
  idempotencyKey: z.string().trim().min(4).max(160),
  eventId: z.uuid().nullable().optional(),
})

export type OperationalAgentMessagePayload = z.infer<typeof operationalAgentMessageSchema>
