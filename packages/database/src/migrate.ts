import { Migrator } from 'kysely/migration'
import { createDatabase } from './database.ts'
import { migration001Foundation } from './migrations/001_foundation.ts'
import { migration002EventPlanning } from './migrations/002_event_planning.ts'
import { migration003Vendors } from './migrations/003_vendors.ts'
import { migration004DomainEventGateway } from './migrations/004_domain_event_gateway.ts'
import { migration005OutboundMessaging } from './migrations/005_outbound_messaging.ts'
import { migration006MessagingWebhooks } from './migrations/006_messaging_webhooks.ts'
import { migration007RestrictMessagingProviders } from './migrations/007_restrict_messaging_providers.ts'
import { migration008SupplierInbound } from './migrations/008_supplier_inbound.ts'
import { migration009OperationalInboxActivity } from './migrations/009_operational_inbox_activity.ts'
import { migration010CommandEngine } from './migrations/010_command_engine.ts'
import { migration011OperationalAgent } from './migrations/011_operational_agent.ts'
import { migration012OperationalAgentToolTraceJsonb } from './migrations/012_operational_agent_tool_trace_jsonb.ts'
import { migration013OperationalAgentOpenRouter } from './migrations/013_operational_agent_openrouter.ts'
import { migration014ChangeProposals } from './migrations/014_change_proposals.ts'
import { migration015DependencyEngine } from './migrations/015_dependency_engine.ts'

const db = createDatabase()
const migrator = new Migrator({
  db,
  provider: {
    async getMigrations() {
      return {
        '001_foundation': migration001Foundation,
        '002_event_planning': migration002EventPlanning,
        '003_vendors': migration003Vendors,
        '004_domain_event_gateway': migration004DomainEventGateway,
        '005_outbound_messaging': migration005OutboundMessaging,
        '006_messaging_webhooks': migration006MessagingWebhooks,
        '007_restrict_messaging_providers': migration007RestrictMessagingProviders,
        '008_supplier_inbound': migration008SupplierInbound,
        '009_operational_inbox_activity': migration009OperationalInboxActivity,
        '010_command_engine': migration010CommandEngine,
        '011_operational_agent': migration011OperationalAgent,
        '012_operational_agent_tool_trace_jsonb': migration012OperationalAgentToolTraceJsonb,
        '013_operational_agent_openrouter': migration013OperationalAgentOpenRouter,
        '014_change_proposals': migration014ChangeProposals,
        '015_dependency_engine': migration015DependencyEngine,
      }
    },
  },
})

const { error, results } = await migrator.migrateToLatest()

for (const result of results ?? []) {
  console.log(`[migration] ${result.migrationName}: ${result.status}`)
}

await db.destroy()

if (error) {
  console.error('[migration] failed', error)
  process.exit(1)
}
