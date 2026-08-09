import { z } from 'zod'

export const createEventSchema = z.object({
  name: z.string().trim().min(2).max(160),
  type: z.enum(['wedding', 'birthday', 'corporate', 'other']),
  templateId: z.uuid().nullable().optional(),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),
  venueName: z.string().trim().max(200).nullable().optional(),
  venueAddress: z.string().trim().max(500).nullable().optional(),
  guestCount: z.number().int().nonnegative().max(100000).default(0),
  ownerUserId: z.uuid().nullable().optional(),
})

export const createEventTaskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  type: z.enum(['general', 'confirmation', 'document', 'payment', 'guest', 'briefing', 'other']).default('general'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  dueAt: z.iso.datetime({ offset: true }),
})

export const updateEventTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' })

export type CreateEventRequest = z.infer<typeof createEventSchema>
export type CreateEventTaskRequest = z.infer<typeof createEventTaskSchema>
export type UpdateEventTaskRequest = z.infer<typeof updateEventTaskSchema>
