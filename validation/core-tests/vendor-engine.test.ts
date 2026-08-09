import type { DomainEvent, Event, EventVendor, Vendor, VendorStore } from '@ecc/domain'
import { VendorEngine } from '../../packages/event-engine/src/vendor-engine.ts'

class InMemoryVendorStore implements VendorStore {
  vendors: Vendor[] = []
  eventVendors: EventVendor[] = []
  outbox: DomainEvent[] = []
  events: Event[] = [{
    id: 'event-1', organizationId: 'org-1', templateId: null, name: 'Ana & Pedro', type: 'wedding',
    startAt: new Date('2026-10-17T20:30:00.000Z'), endAt: null, venueName: null, venueAddress: null,
    guestCount: 132, status: 'planning', healthScore: 100, ownerUserId: null,
    createdAt: new Date('2026-08-09T15:00:00.000Z'), updatedAt: new Date('2026-08-09T15:00:00.000Z'),
  }]
  async createVendor(vendor: Vendor) { this.vendors.push({ ...vendor }) }
  async findVendorById(org: string, id: string) { return this.vendors.find(v => v.organizationId === org && v.id === id) ?? null }
  async listVendors(org: string) { return this.vendors.filter(v => v.organizationId === org) }
  async findEventById(org: string, id: string) { return this.events.find(e => e.organizationId === org && e.id === id) ?? null }
  async findEventVendorById(org: string, eventId: string, id: string) { return this.eventVendors.find(v => v.organizationId === org && v.eventId === eventId && v.id === id) ?? null }
  async findEventVendorByVendorId(org: string, eventId: string, vendorId: string) { return this.eventVendors.find(v => v.organizationId === org && v.eventId === eventId && v.vendorId === vendorId) ?? null }
  async listEventVendors(org: string, eventId: string) { return this.eventVendors.filter(v => v.organizationId === org && v.eventId === eventId) }
  async createEventVendorWithOutbox(value: EventVendor, event: DomainEvent) { this.eventVendors.push({ ...value }); this.outbox.push(event) }
  async updateEventVendorWithOutbox(value: EventVendor, event: DomainEvent) {
    const i = this.eventVendors.findIndex(v => v.id === value.id); if (i >= 0) this.eventVendors[i] = { ...value }; this.outbox.push(event)
  }
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Assertion failed: ${message}`) }
async function rejects(fn: () => Promise<unknown>, re: RegExp) { try { await fn() } catch (e) { assert(re.test(e instanceof Error ? e.message : String(e)), `expected ${re}`); return } throw new Error(`Expected ${re}`) }
function fixture() {
  const store = new InMemoryVendorStore(); let id = 0
  const engine = new VendorEngine({ store, now: () => new Date('2026-08-09T15:00:00.000Z'), newId: () => `generated-${++id}` })
  return { store, engine }
}
async function makeVendor(engine: VendorEngine) {
  return engine.createVendor({ organizationId: 'org-1', name: '  Luz Foto  ', category: 'photo', contactName: ' Carla ', phone: ' +5521999999999 ', email: 'FOTO@EXAMPLE.COM' })
}

async function createAndNormalize() {
  const { engine } = fixture(); const vendor = await makeVendor(engine)
  assert(vendor.name === 'Luz Foto', 'name normalized'); assert(vendor.email === 'foto@example.com', 'email normalized')
}
async function attachSnapshot() {
  const { engine, store } = fixture(); const vendor = await makeVendor(engine)
  const assignment = await engine.attachVendorToEvent({ organizationId: 'org-1', eventId: 'event-1', vendorId: vendor.id, teamSize: 3 })
  assert(assignment.vendorName === 'Luz Foto' && assignment.category === 'photo', 'catalog snapshot copied')
  assert(assignment.confirmationStatus === 'pending', 'initial status pending')
  assert(store.outbox.at(-1)?.eventType === 'vendor.attached', 'vendor.attached emitted')
}
async function tenantIsolation() {
  const { engine } = fixture(); const vendor = await makeVendor(engine)
  await rejects(() => engine.attachVendorToEvent({ organizationId: 'org-2', eventId: 'event-1', vendorId: vendor.id }), /Event not found/)
}
async function duplicateRejected() {
  const { engine } = fixture(); const vendor = await makeVendor(engine)
  await engine.attachVendorToEvent({ organizationId: 'org-1', eventId: 'event-1', vendorId: vendor.id })
  await rejects(() => engine.attachVendorToEvent({ organizationId: 'org-1', eventId: 'event-1', vendorId: vendor.id }), /already attached/)
}
async function confirmationLifecycle() {
  const { engine, store } = fixture(); const vendor = await makeVendor(engine)
  const assignment = await engine.attachVendorToEvent({ organizationId: 'org-1', eventId: 'event-1', vendorId: vendor.id })
  const requested = await engine.requestConfirmation({ organizationId: 'org-1', eventId: 'event-1', eventVendorId: assignment.id, deadlineAt: new Date('2026-10-10T12:00:00Z') })
  assert(requested.confirmationStatus === 'requested' && requested.confirmationRequestedAt !== null, 'request recorded')
  assert(store.outbox.at(-1)?.eventType === 'vendor.confirmation_requested', 'request event emitted')
  const confirmed = await engine.confirm({ organizationId: 'org-1', eventId: 'event-1', eventVendorId: assignment.id, arrivalAt: new Date('2026-10-17T17:30:00Z'), teamSize: 4 })
  assert(confirmed.confirmationStatus === 'confirmed' && confirmed.teamSize === 4 && confirmed.confirmedAt !== null, 'confirmation recorded')
  assert(store.outbox.at(-1)?.eventType === 'vendor.confirmed', 'confirmed event emitted')
}
async function declineLifecycle() {
  const { engine, store } = fixture(); const vendor = await makeVendor(engine)
  const assignment = await engine.attachVendorToEvent({ organizationId: 'org-1', eventId: 'event-1', vendorId: vendor.id })
  const declined = await engine.decline({ organizationId: 'org-1', eventId: 'event-1', eventVendorId: assignment.id, notes: 'Indisponível' })
  assert(declined.confirmationStatus === 'declined' && declined.declinedAt !== null, 'decline recorded')
  assert(store.outbox.at(-1)?.eventType === 'vendor.declined', 'declined event emitted')
}
async function invalidWindow() {
  const { engine } = fixture(); const vendor = await makeVendor(engine)
  await rejects(() => engine.attachVendorToEvent({ organizationId: 'org-1', eventId: 'event-1', vendorId: vendor.id, arrivalAt: new Date('2026-10-17T18:00:00Z'), departureAt: new Date('2026-10-17T17:00:00Z') }), /departureAt cannot be earlier/)
}

await createAndNormalize(); await attachSnapshot(); await tenantIsolation(); await duplicateRejected(); await confirmationLifecycle(); await declineLifecycle(); await invalidWindow()
console.log('PASS: VendorEngine behavioral validation (7 scenarios)')
