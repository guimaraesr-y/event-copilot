import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import {
  checkDatabase,
  DomainEventGatewayRepository,
  EventTemplateRepository,
  KyselyEventStore,
  KyselyVendorStore,
  KyselyMessageStore,
  OrganizationRepository,
  type DatabaseSchema,
} from '@ecc/database'
import { EventEngine, VendorEngine, MessagingEngine } from '@ecc/event-engine'
import { registerHealthRoutes } from './routes/health.ts'
import { registerOrganizationRoutes } from './routes/organizations.ts'
import { registerEventRoutes } from './routes/events.ts'
import { registerEventTemplateRoutes } from './routes/event-templates.ts'
import { registerVendorRoutes } from './routes/vendors.ts'
import { registerDomainEventRoutes } from './routes/domain-events.ts'
import { registerMessagingRoutes } from './routes/messaging.ts'
import { createMessagingProvider } from './messaging-provider.ts'

export function createApp(db: Kysely<DatabaseSchema>) {
  const app = new Hono()
  const organizationRepository = new OrganizationRepository(db)
  const eventTemplateRepository = new EventTemplateRepository(db)
  const eventEngine = new EventEngine({ store: new KyselyEventStore(db) })
  const vendorEngine = new VendorEngine({ store: new KyselyVendorStore(db) })
  const domainEventGatewayRepository = new DomainEventGatewayRepository(db)
  const messagingEngine = new MessagingEngine({ store: new KyselyMessageStore(db), provider: createMessagingProvider() })

  app.onError((error, c) => {
    console.error('[api] unhandled error', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } }, 500)
  })

  registerHealthRoutes(app, () => checkDatabase(db))
  registerOrganizationRoutes(app, organizationRepository)
  registerEventTemplateRoutes(app, organizationRepository, eventTemplateRepository)
  registerEventRoutes(app, organizationRepository, eventEngine)
  registerVendorRoutes(app, organizationRepository, vendorEngine)
  registerDomainEventRoutes(app, domainEventGatewayRepository)
  registerMessagingRoutes(app, messagingEngine)

  return app
}
