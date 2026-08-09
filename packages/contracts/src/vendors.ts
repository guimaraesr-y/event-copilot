import { z } from 'zod'

const nullableDate = z.iso.datetime({ offset: true }).nullable().optional()

export const createVendorSchema = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.enum(['buffet','photo','video','decoration','dj','band','cake','sweets','venue','transport','celebrant','security','other']),
  contactName: z.string().trim().max(160).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export const attachVendorToEventSchema = z.object({
  vendorId: z.uuid(),
  contactName: z.string().trim().max(160).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  arrivalAt: nullableDate,
  departureAt: nullableDate,
  teamSize: z.number().int().nonnegative().max(10000).nullable().optional(),
  contractStatus: z.enum(['not_applicable','pending','signed']).optional(),
  paymentStatus: z.enum(['not_applicable','pending','partial','paid','overdue']).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export const updateEventVendorSchema = attachVendorToEventSchema.omit({ vendorId: true }).refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field is required' },
)

export const requestVendorConfirmationSchema = z.object({
  deadlineAt: nullableDate,
})

export const confirmVendorSchema = z.object({
  arrivalAt: nullableDate,
  departureAt: nullableDate,
  teamSize: z.number().int().nonnegative().max(10000).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export const declineVendorSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
})
