import { z } from 'zod'

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).default('America/Sao_Paulo'),
})

export type CreateOrganizationRequest = z.infer<typeof createOrganizationSchema>
