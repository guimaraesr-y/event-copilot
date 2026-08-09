import type { Hono } from 'hono'
import { createOrganizationSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'

export function registerOrganizationRoutes(app: Hono, repository: OrganizationRepository): void {
  app.post('/api/v1/organizations', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = createOrganizationSchema.safeParse(body)

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid organization payload', issues: parsed.error.issues } },
        400,
      )
    }

    const organization = await repository.create(parsed.data.name, parsed.data.timezone)
    return c.json({ data: serializeOrganization(organization) }, 201)
  })
}

function serializeOrganization(organization: Awaited<ReturnType<OrganizationRepository['create']>>) {
  return {
    ...organization,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  }
}
