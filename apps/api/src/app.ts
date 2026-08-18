import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import {
  checkDatabase,
  DomainEventGatewayRepository,
  EventTemplateRepository,
  KyselyEventStore,
  KyselyVendorStore,
  KyselyMessageStore,
  KyselyInboundMessageStore,
  OperationalRepository,
  KyselyCommandStore,
  KyselyAgentStore,
  KyselyChangeProposalStore,
  OrganizationRepository,
  type DatabaseSchema,
} from '@ecc/database'
import { EventEngine, VendorEngine, MessagingEngine, InboundEngine, RuleBasedSupplierResponseInterpreter, CommandEngine, OperationalAgent, ChangeProposalEngine } from '@ecc/event-engine'
import { registerHealthRoutes } from './routes/health.ts'
import { registerOrganizationRoutes } from './routes/organizations.ts'
import { registerEventRoutes } from './routes/events.ts'
import { registerEventTemplateRoutes } from './routes/event-templates.ts'
import { registerVendorRoutes } from './routes/vendors.ts'
import { registerDomainEventRoutes } from './routes/domain-events.ts'
import { registerMessagingRoutes } from './routes/messaging.ts'
import { registerMessagingWebhookRoutes } from './routes/messaging-webhooks.ts'
import { registerInboundMessageRoutes } from './routes/inbound-messages.ts'
import { registerOperationalRoutes } from './routes/operations.ts'
import { registerCommandRoutes } from './routes/commands.ts'
import { createCommandInterpreter } from './command-interpreter.ts'
import { createOperationalAgentProvider, operationalAgentLimits } from './operational-agent.ts'
import { registerOperationalAgentRoutes } from './routes/agent.ts'
import { registerChangeProposalRoutes } from './routes/change-proposals.ts'
import { createMessagingProvider, createMessagingWebhookRegistry } from '@ecc/messaging'

export function createApp(db: Kysely<DatabaseSchema>) {
  const app = new Hono()
  const organizationRepository = new OrganizationRepository(db)
  const eventTemplateRepository = new EventTemplateRepository(db)
  const eventEngine = new EventEngine({ store: new KyselyEventStore(db) })
  const vendorEngine = new VendorEngine({ store: new KyselyVendorStore(db) })
  const domainEventGatewayRepository = new DomainEventGatewayRepository(db)
  const messagingEngine = new MessagingEngine({ store: new KyselyMessageStore(db), provider: createMessagingProvider() })
  const operationalRepository = new OperationalRepository(db)
  const commandStore = new KyselyCommandStore(db)
  const commandEngine = new CommandEngine({ store: commandStore, eventEngine, vendorEngine, interpreter: createCommandInterpreter() })
  const changeProposalEngine = new ChangeProposalEngine({ store: new KyselyChangeProposalStore(db), eventEngine, vendorEngine })
  const operationalAgent = new OperationalAgent({
    store: new KyselyAgentStore(db),
    provider: createOperationalAgentProvider(),
    eventEngine,
    vendorEngine,
    commandEngine,
    changeProposalEngine,
    operations: operationalRepository,
    ...operationalAgentLimits(),
  })
  const inboundEngine = new InboundEngine({
    store: new KyselyInboundMessageStore(db),
    vendorEngine,
    interpreter: new RuleBasedSupplierResponseInterpreter(),
  })

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
  registerMessagingWebhookRoutes(app, messagingEngine, createMessagingWebhookRegistry())
  registerInboundMessageRoutes(app, inboundEngine)
  registerOperationalRoutes(app, organizationRepository, operationalRepository)
  registerCommandRoutes(app, organizationRepository, commandEngine)
  registerOperationalAgentRoutes(app, organizationRepository, operationalAgent)
  registerChangeProposalRoutes(app, organizationRepository, changeProposalEngine)

  return app
}
