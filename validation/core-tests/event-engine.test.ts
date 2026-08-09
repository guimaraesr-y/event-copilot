import type { DomainEvent, Event, EventStore } from '@ecc/domain'
import { EventEngine } from '../../packages/event-engine/src/event-engine.ts'

class InMemoryStore implements EventStore {
  readonly events: Event[] = []
  readonly outbox: DomainEvent[] = []

  async createEventWithOutbox(event: Event, domainEvent: DomainEvent): Promise<void> {
    this.events.push(event)
    this.outbox.push(domainEvent)
  }

  async findEventById(organizationId: string, eventId: string): Promise<Event | null> {
    return this.events.find((event) => event.organizationId === organizationId && event.id === eventId) ?? null
  }

  async listEvents(organizationId: string): Promise<Event[]> {
    return this.events.filter((event) => event.organizationId === organizationId)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

async function assertRejects(fn: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(expected.test(message), `expected ${expected}, received ${message}`)
    return
  }
  throw new Error(`Expected rejection matching ${expected}`)
}

function engineFixture() {
  const store = new InMemoryStore()
  const ids = ['event-1', 'outbox-1']
  const engine = new EventEngine({
    store,
    now: () => new Date('2026-08-09T14:00:00.000Z'),
    newId: () => ids.shift() ?? 'unexpected-id',
  })
  return { engine, store }
}

async function testCreateEvent(): Promise<void> {
  const { engine, store } = engineFixture()
  const event = await engine.createEvent({
    organizationId: 'org-1',
    name: '  Ana & Pedro  ',
    type: 'wedding',
    startAt: new Date('2026-10-17T20:30:00.000Z'),
    guestCount: 132,
  })

  assert(event.name === 'Ana & Pedro', 'event name is normalized')
  assert(event.status === 'planning', 'event starts in planning')
  assert(event.healthScore === 100, 'event starts healthy')
  assert(store.events.length === 1, 'event persisted once')
  assert(store.outbox.length === 1, 'outbox persisted once')
  assert(store.outbox[0]?.eventType === 'event.created', 'event.created emitted')
  assert(store.outbox[0]?.aggregateId === event.id, 'outbox aggregate points to event')
  assert(store.outbox[0]?.payload.eventId === 'event-1', 'outbox payload contains event id')
}

async function testInvalidDates(): Promise<void> {
  const { engine } = engineFixture()
  await assertRejects(
    () => engine.createEvent({
      organizationId: 'org-1',
      name: 'Evento teste',
      type: 'other',
      startAt: new Date('2026-10-17T20:30:00.000Z'),
      endAt: new Date('2026-10-17T19:30:00.000Z'),
    }),
    /endAt cannot be earlier than startAt/,
  )
}

async function testNegativeGuests(): Promise<void> {
  const { engine } = engineFixture()
  await assertRejects(
    () => engine.createEvent({
      organizationId: 'org-1',
      name: 'Evento teste',
      type: 'other',
      startAt: new Date('2026-10-17T20:30:00.000Z'),
      guestCount: -1,
    }),
    /guestCount must be a non-negative integer/,
  )
}

await testCreateEvent()
await testInvalidDates()
await testNegativeGuests()
console.log('PASS: EventEngine behavioral validation (3 scenarios)')
