import { z } from 'zod'

const base = z.object({
  sender: z.string().trim().min(2).max(128),
  idempotencyKey: z.string().trim().min(4).max(180),
  reason: z.string().trim().max(2000).nullable().optional(),
})

export const createChangeProposalSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('event_date'), proposedValue: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) }),
  base.extend({ type: z.literal('event_time'), proposedValue: z.object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }) }),
  base.extend({ type: z.literal('guest_count'), proposedValue: z.object({ guestCount: z.number().int().min(0).max(100000) }) }),
  base.extend({ type: z.literal('venue'), proposedValue: z.object({ venueName: z.string().trim().max(200).nullable().optional(), venueAddress: z.string().trim().max(500).nullable().optional() }).refine((v) => Boolean(v.venueName || v.venueAddress), { message: 'venueName or venueAddress is required' }) }),
])

export const decideChangeProposalSchema = z.object({
  sender: z.string().trim().min(2).max(128),
  reason: z.string().trim().max(2000).nullable().optional(),
})
