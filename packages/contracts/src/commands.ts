import { z } from 'zod'

export const executeCommandSchema = z.object({
  sender: z.string().trim().min(2).max(128),
  text: z.string().trim().min(2).max(4000),
  idempotencyKey: z.string().trim().min(4).max(160),
  eventId: z.uuid().nullable().optional(),
})

export type ExecuteCommandPayload = z.infer<typeof executeCommandSchema>
