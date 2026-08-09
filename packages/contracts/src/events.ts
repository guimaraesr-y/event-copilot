import { z } from 'zod'

export const createEventSchema = z.object({
  name: z.string().trim().min(2).max(160),
  type: z.enum(['wedding', 'birthday', 'corporate', 'other']),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),
  venueName: z.string().trim().max(200).nullable().optional(),
  venueAddress: z.string().trim().max(500).nullable().optional(),
  guestCount: z.number().int().nonnegative().max(100000).default(0),
  ownerUserId: z.uuid().nullable().optional(),
})

export type CreateEventRequest = z.infer<typeof createEventSchema>
