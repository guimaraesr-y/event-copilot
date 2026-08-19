import { createHmac } from 'node:crypto'
import { hostname } from 'node:os'
import { createDatabase, OperationalRepository, OutboxRepository, OrganizationRepository, KyselyEventStore, KyselyVendorStore, KyselyDependencyStore } from '@ecc/database'
import { canonicalizeDomainEvent, type DomainEventEnvelope } from '@ecc/contracts'
import type { OutboxMessage } from '@ecc/domain'
import { OperationalProjector, EventEngine, VendorEngine, DependencyEngine } from '@ecc/event-engine'

const db = createDatabase()
const outbox = new OutboxRepository(db)
const operations = new OperationalRepository(db)
const operationalProjector = new OperationalProjector()
const organizations = new OrganizationRepository(db)
const eventEngine = new EventEngine({ store: new KyselyEventStore(db) })
const vendorEngine = new VendorEngine({ store: new KyselyVendorStore(db) })
const dependencyEngine = new DependencyEngine({ store: new KyselyDependencyStore(db), eventEngine, vendorEngine })
const workerId = `${hostname()}-${process.pid}`
const pollInterval = parsePositiveInt(process.env.OUTBOX_POLL_INTERVAL_MS, 2000)
const batchSize = parsePositiveInt(process.env.OUTBOX_BATCH_SIZE, 20)
const transport = process.env.OUTBOX_TRANSPORT ?? 'console'

console.log(`[worker] started id=${workerId} transport=${transport}`)

let stopping = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[worker] received ${signal}`)
    stopping = true
  })
}

async function dispatch(message: OutboxMessage): Promise<void> {
  if (transport === 'console') {
    console.log(`[outbox] ${message.eventType} ${message.aggregateType}:${message.aggregateId}`, message.payload)
    return
  }

  if (transport === 'n8n') {
    const url = process.env.N8N_DOMAIN_EVENTS_URL
    const secret = process.env.DOMAIN_EVENT_SHARED_SECRET
    if (!url) throw new Error('N8N_DOMAIN_EVENTS_URL is required when OUTBOX_TRANSPORT=n8n')
    if (!secret || secret.length < 32) throw new Error('DOMAIN_EVENT_SHARED_SECRET must contain at least 32 characters')

    const envelope: DomainEventEnvelope = {
      schemaVersion: 1,
      id: message.id,
      organizationId: message.organizationId,
      eventType: message.eventType,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      occurredAt: message.occurredAt.toISOString(),
      payload: message.payload,
    }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${canonicalizeDomainEvent(envelope)}`)
      .digest('hex')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ecc-event-id': message.id,
        'x-ecc-timestamp': timestamp,
        'x-ecc-signature': `sha256=${signature}`,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      throw new Error(`n8n returned ${response.status}: ${(await response.text()).slice(0, 500)}`)
    }
    return
  }

  throw new Error(`Unsupported OUTBOX_TRANSPORT: ${transport}`)
}

async function tick(): Promise<void> {
  const messages = await outbox.claimBatch(workerId, batchSize)
  for (const message of messages) {
    try {
      if (message.eventType === 'change.applied') {
        const organization = await organizations.findById(message.organizationId)
        if (!organization) throw new Error(`Organization ${message.organizationId} not found for dependency evaluation`)
        await dependencyEngine.evaluateAppliedChange(message, organization.timezone)
      }
      await operations.applyProjection(message, operationalProjector.project(message))
      await dispatch(message)
      await outbox.markDispatched(message.id, workerId)
    } catch (error) {
      console.error(`[worker] failed event=${message.id}`, error)
      await outbox.markFailed(message.id, workerId, message.attempts + 1, error)
    }
  }
}

while (!stopping) {
  try {
    await tick()
  } catch (error) {
    console.error('[worker] poll failed', error)
  }
  await Bun.sleep(pollInterval)
}

await db.destroy()

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
