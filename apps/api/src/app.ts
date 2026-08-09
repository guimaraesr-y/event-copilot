import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import {
  checkDatabase,
  EventTemplateRepository,
  KyselyEventStore,
  KyselyVendorStore,
  OrganizationRepository,
  type DatabaseSchema,
} from '@ecc/database'
import { EventEngine, VendorEngine } from '@ecc/event-engine'
import { registerHealthRoutes } from './routes/health.ts'
import { registerOrganizationRoutes } from './routes/organizations.ts'
import { registerEventRoutes } from './routes/events.ts'
import { registerEventTemplateRoutes } from './routes/event-templates.ts'
import { registerVendorRoutes } from './routes/vendors.ts'

export function createApp(db: Kysely<DatabaseSchema>) {
  const app = new Hono()
  const organizationRepository = new OrganizationRepository(db)
  const eventTemplateRepository = new EventTemplateRepository(db)
  const eventEngine = new EventEngine({ store: new KyselyEventStore(db) })
  const vendorEngine = new VendorEngine({ store: new KyselyVendorStore(db) })

  app.onError((error, c) => {
    console.error('[api] unhandled error', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } }, 500)
  })

  registerHealthRoutes(app, () => checkDatabase(db))
  registerOrganizationRoutes(app, organizationRepository)
  registerEventTemplateRoutes(app, organizationRepository, eventTemplateRepository)
  registerEventRoutes(app, organizationRepository, eventEngine)
  registerVendorRoutes(app, organizationRepository, vendorEngine)

  return app
}
