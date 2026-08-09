import { z } from 'zod'

const dueTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'dueTime must use HH:mm format')

export const createEventTemplateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  eventType: z.enum(['wedding', 'birthday', 'corporate', 'other']),
  description: z.string().trim().max(1000).nullable().optional(),
})

export const createEventTemplateTaskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  offsetDays: z.number().int().min(-3650).max(3650),
  dueTime: dueTimeSchema.default('09:00'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  type: z.enum(['general', 'confirmation', 'document', 'payment', 'guest', 'briefing', 'other']).default('general'),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
})

export const createEventTemplateMilestoneSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  offsetDays: z.number().int().min(-3650).max(3650),
  dueTime: dueTimeSchema.default('09:00'),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
})

export type CreateEventTemplateRequest = z.infer<typeof createEventTemplateSchema>
export type CreateEventTemplateTaskRequest = z.infer<typeof createEventTemplateTaskSchema>
export type CreateEventTemplateMilestoneRequest = z.infer<typeof createEventTemplateMilestoneSchema>
