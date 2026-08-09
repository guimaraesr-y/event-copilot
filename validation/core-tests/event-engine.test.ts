import type {
  DomainEvent,
  Event,
  EventMilestone,
  EventStore,
  EventTask,
  EventTemplateSnapshot,
} from '@ecc/domain'
import { EventEngine } from '../../packages/event-engine/src/event-engine.ts'

class InMemoryStore implements EventStore {
  readonly events: Event[] = []
  readonly tasks: EventTask[] = []
  readonly milestones: EventMilestone[] = []
  readonly outbox: DomainEvent[] = []
  template: EventTemplateSnapshot | null = null

  async findTemplateSnapshot(organizationId: string, templateId: string): Promise<EventTemplateSnapshot | null> {
    if (!this.template) return null
    return this.template.organizationId === organizationId && this.template.id === templateId ? this.template : null
  }

  async createEventWithPlan(
    event: Event,
    tasks: EventTask[],
    milestones: EventMilestone[],
    domainEvents: DomainEvent[],
  ): Promise<void> {
    this.events.push({ ...event })
    this.tasks.push(...tasks.map((task) => ({ ...task })))
    this.milestones.push(...milestones.map((milestone) => ({ ...milestone })))
    this.outbox.push(...domainEvents.map((domainEvent) => ({ ...domainEvent, payload: { ...domainEvent.payload } })))
  }

  async findEventById(organizationId: string, eventId: string): Promise<Event | null> {
    return this.events.find((event) => event.organizationId === organizationId && event.id === eventId) ?? null
  }

  async listEvents(organizationId: string): Promise<Event[]> {
    return this.events.filter((event) => event.organizationId === organizationId)
  }

  async listEventTasks(organizationId: string, eventId: string): Promise<EventTask[]> {
    return this.tasks.filter((task) => task.organizationId === organizationId && task.eventId === eventId)
  }

  async listEventMilestones(organizationId: string, eventId: string): Promise<EventMilestone[]> {
    return this.milestones.filter((milestone) => milestone.organizationId === organizationId && milestone.eventId === eventId)
  }

  async createTaskWithOutbox(task: EventTask, domainEvent: DomainEvent): Promise<void> {
    this.tasks.push({ ...task })
    this.outbox.push({ ...domainEvent, payload: { ...domainEvent.payload } })
  }

  async updateTaskWithOutbox(task: EventTask, domainEvent: DomainEvent): Promise<void> {
    const index = this.tasks.findIndex((candidate) => candidate.id === task.id)
    if (index >= 0) this.tasks[index] = { ...task }
    this.outbox.push({ ...domainEvent, payload: { ...domainEvent.payload } })
  }

  async findTaskById(organizationId: string, eventId: string, taskId: string): Promise<EventTask | null> {
    return this.tasks.find(
      (task) => task.organizationId === organizationId && task.eventId === eventId && task.id === taskId,
    ) ?? null
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
  let id = 0
  const engine = new EventEngine({
    store,
    now: () => new Date('2026-08-09T15:00:00.000Z'),
    newId: () => `generated-${++id}`,
  })
  return { engine, store }
}

function weddingTemplate(): EventTemplateSnapshot {
  return {
    id: 'template-1',
    organizationId: 'org-1',
    name: 'Casamento Padrão',
    eventType: 'wedding',
    description: null,
    isActive: true,
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    tasks: [
      {
        id: 'template-task-rsvp',
        organizationId: 'org-1',
        templateId: 'template-1',
        title: 'Fechar RSVP',
        description: null,
        offsetDays: -30,
        dueTime: '09:00',
        priority: 'high',
        type: 'guest',
        sortOrder: 10,
        createdAt: new Date('2026-08-01T12:00:00.000Z'),
      },
      {
        id: 'template-task-vendors',
        organizationId: 'org-1',
        templateId: 'template-1',
        title: 'Confirmar fornecedores',
        description: null,
        offsetDays: -7,
        dueTime: '10:00',
        priority: 'critical',
        type: 'confirmation',
        sortOrder: 20,
        createdAt: new Date('2026-08-01T12:00:00.000Z'),
      },
    ],
    milestones: [
      {
        id: 'template-milestone-final',
        organizationId: 'org-1',
        templateId: 'template-1',
        name: 'Checklist final',
        description: null,
        offsetDays: -1,
        dueTime: '18:00',
        sortOrder: 10,
        createdAt: new Date('2026-08-01T12:00:00.000Z'),
      },
    ],
  }
}

async function createWedding(engine: EventEngine, templateId?: string): Promise<Event> {
  return engine.createEvent({
    organizationId: 'org-1',
    organizationTimezone: 'America/Sao_Paulo',
    ...(templateId ? { templateId } : {}),
    name: '  Ana & Pedro  ',
    type: 'wedding',
    startAt: new Date('2026-10-17T20:30:00.000Z'),
    guestCount: 132,
  })
}

async function testCreateEventWithoutTemplate(): Promise<void> {
  const { engine, store } = engineFixture()
  const event = await createWedding(engine)
  assert(event.name === 'Ana & Pedro', 'event name is normalized')
  assert(event.templateId === null, 'event can be created without template')
  assert(store.tasks.length === 0, 'no tasks are created without template')
  assert(store.milestones.length === 0, 'no milestones are created without template')
  assert(store.outbox.length === 1 && store.outbox[0]?.eventType === 'event.created', 'event.created emitted')
}

async function testInstantiateTemplatePlan(): Promise<void> {
  const { engine, store } = engineFixture()
  store.template = weddingTemplate()
  const event = await createWedding(engine, 'template-1')

  assert(event.templateId === 'template-1', 'event keeps template traceability')
  assert(store.tasks.length === 2, 'all template tasks are copied')
  assert(store.milestones.length === 1, 'all template milestones are copied')
  assert(store.tasks[0]?.dueAt.toISOString() === '2026-09-17T12:00:00.000Z', 'D-30 at 09:00 uses organization timezone')
  assert(store.tasks[1]?.dueAt.toISOString() === '2026-10-10T13:00:00.000Z', 'D-7 at 10:00 uses organization timezone')
  assert(store.milestones[0]?.dueAt.toISOString() === '2026-10-16T21:00:00.000Z', 'milestone date is calculated in local time')
  assert(store.tasks.every((task) => task.source === 'template'), 'instantiated tasks identify template source')
  assert(store.outbox.some((item) => item.eventType === 'event.created'), 'event.created emitted')
  const planEvent = store.outbox.find((item) => item.eventType === 'event.plan_initialized')
  assert(planEvent?.payload.tasksCreated === 2, 'plan event reports task count')
  assert(planEvent?.payload.milestonesCreated === 1, 'plan event reports milestone count')
}

async function testTenantIsolationForTemplate(): Promise<void> {
  const { engine, store } = engineFixture()
  store.template = weddingTemplate()
  await assertRejects(
    () => engine.createEvent({
      organizationId: 'org-2',
      organizationTimezone: 'America/Sao_Paulo',
      templateId: 'template-1',
      name: 'Outro casamento',
      type: 'wedding',
      startAt: new Date('2026-10-17T20:30:00.000Z'),
    }),
    /Event template not found/,
  )
}

async function testTemplateTypeMismatch(): Promise<void> {
  const { engine, store } = engineFixture()
  store.template = weddingTemplate()
  await assertRejects(
    () => engine.createEvent({
      organizationId: 'org-1',
      organizationTimezone: 'America/Sao_Paulo',
      templateId: 'template-1',
      name: 'Evento corporativo',
      type: 'corporate',
      startAt: new Date('2026-10-17T20:30:00.000Z'),
    }),
    /cannot be used for event type corporate/,
  )
}

async function testTemplateChangesDoNotMutateEventPlan(): Promise<void> {
  const { engine, store } = engineFixture()
  store.template = weddingTemplate()
  await createWedding(engine, 'template-1')
  const copiedTitle = store.tasks[0]?.title
  store.template.tasks[0]!.title = 'Novo título do template'
  assert(copiedTitle === 'Fechar RSVP', 'fixture copied expected task')
  assert(store.tasks[0]?.title === 'Fechar RSVP', 'existing event task is an immutable template snapshot')
}

async function testManualTaskLifecycle(): Promise<void> {
  const { engine, store } = engineFixture()
  const event = await createWedding(engine)
  const task = await engine.createManualTask({
    organizationId: 'org-1',
    eventId: event.id,
    title: 'Confirmar bolo',
    dueAt: new Date('2026-10-10T12:00:00.000Z'),
    priority: 'high',
  })
  assert(task.source === 'manual', 'manual task source is preserved')
  assert(store.outbox.at(-1)?.eventType === 'task.created', 'task.created emitted')

  const completed = await engine.updateTask({
    organizationId: 'org-1',
    eventId: event.id,
    taskId: task.id,
    status: 'completed',
  })
  assert(completed.completedAt?.toISOString() === '2026-08-09T15:00:00.000Z', 'completion timestamp is set')
  assert(store.outbox.at(-1)?.eventType === 'task.completed', 'task.completed emitted')
}

async function testInvalidDates(): Promise<void> {
  const { engine } = engineFixture()
  await assertRejects(
    () => engine.createEvent({
      organizationId: 'org-1',
      organizationTimezone: 'America/Sao_Paulo',
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
      organizationTimezone: 'America/Sao_Paulo',
      name: 'Evento teste',
      type: 'other',
      startAt: new Date('2026-10-17T20:30:00.000Z'),
      guestCount: -1,
    }),
    /guestCount must be a non-negative integer/,
  )
}

await testCreateEventWithoutTemplate()
await testInstantiateTemplatePlan()
await testTenantIsolationForTemplate()
await testTemplateTypeMismatch()
await testTemplateChangesDoNotMutateEventPlan()
await testManualTaskLifecycle()
await testInvalidDates()
await testNegativeGuests()
console.log('PASS: EventEngine behavioral validation (8 scenarios)')
