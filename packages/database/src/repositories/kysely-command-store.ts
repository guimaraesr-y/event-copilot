import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import type {
  CommandRequest,
  CommandStore,
  ConversationContext,
  CreateCommandRequestInput,
  DomainEvent,
  EventNote,
  UpdateCommandRequestInput,
} from '@ecc/domain'
import type { CommandRequestsTable, ConversationContextsTable, DatabaseSchema, EventNotesTable } from '../db-types.ts'

export class KyselyCommandStore implements CommandStore {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async createRequestIfAbsent(input: CreateCommandRequestInput): Promise<{ request: CommandRequest; created: boolean }> {
    const inserted = await this.db.insertInto('command_requests').values({
      id: input.id,
      organization_id: input.organizationId,
      sender: input.sender,
      idempotency_key: input.idempotencyKey,
      raw_text: input.rawText,
      explicit_event_id: input.explicitEventId ?? null,
      resolved_event_id: null,
      interpreter: input.interpreter,
      intent: null,
      confidence: null,
      status: 'received',
      interpretation: null,
      result: null,
      created_at: input.now,
      updated_at: input.now,
      processed_at: null,
      last_error: null,
    }).onConflict((oc) => oc.columns(['organization_id','idempotency_key']).doNothing())
      .returningAll().executeTakeFirst()

    if (inserted) return { request: mapCommandRequest(inserted), created: true }
    const existing = await this.db.selectFrom('command_requests').selectAll()
      .where('organization_id', '=', input.organizationId).where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow()
    return { request: mapCommandRequest(existing), created: false }
  }

  async findRequestById(organizationId: string, requestId: string): Promise<CommandRequest | null> {
    const row = await this.db.selectFrom('command_requests').selectAll()
      .where('organization_id', '=', organizationId).where('id', '=', requestId).executeTakeFirst()
    return row ? mapCommandRequest(row) : null
  }

  async updateRequest(organizationId: string, requestId: string, input: UpdateCommandRequestInput): Promise<CommandRequest> {
    const patch: Record<string, unknown> = { updated_at: input.updatedAt }
    if ('resolvedEventId' in input) patch.resolved_event_id = input.resolvedEventId ?? null
    if ('intent' in input) patch.intent = input.intent ?? null
    if ('confidence' in input) patch.confidence = input.confidence ?? null
    if (input.status !== undefined) patch.status = input.status
    if ('interpretation' in input) patch.interpretation = input.interpretation ?? null
    if ('result' in input) patch.result = input.result ?? null
    if ('processedAt' in input) patch.processed_at = input.processedAt ?? null
    if ('lastError' in input) patch.last_error = input.lastError ?? null

    const row = await this.db.updateTable('command_requests').set(patch as any)
      .where('organization_id', '=', organizationId).where('id', '=', requestId)
      .returningAll().executeTakeFirstOrThrow()
    return mapCommandRequest(row)
  }

  async getConversationContext(organizationId: string, sender: string): Promise<ConversationContext | null> {
    const row = await this.db.selectFrom('conversation_contexts').selectAll()
      .where('organization_id', '=', organizationId).where('sender', '=', sender).executeTakeFirst()
    return row ? mapConversationContext(row) : null
  }

  async setConversationContext(organizationId: string, sender: string, eventId: string | null, at: Date): Promise<ConversationContext> {
    const id = crypto.randomUUID()
    const row = await this.db.insertInto('conversation_contexts').values({
      id, organization_id: organizationId, sender, current_event_id: eventId,
      last_interaction_at: at, created_at: at, updated_at: at,
    }).onConflict((oc) => oc.columns(['organization_id','sender']).doUpdateSet({
      current_event_id: eventId, last_interaction_at: at, updated_at: at,
    })).returningAll().executeTakeFirstOrThrow()
    return mapConversationContext(row)
  }

  async countOpenInbox(organizationId: string, eventId: string): Promise<number> {
    const row = await this.db.selectFrom('inbox_items').select(sql<number>`count(*)`.as('count'))
      .where('organization_id', '=', organizationId).where('event_id', '=', eventId)
      .where('status', 'in', ['open','in_progress']).executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async findNoteByCommandRequestId(organizationId: string, commandRequestId: string): Promise<EventNote | null> {
    const row = await this.db.selectFrom('event_notes').selectAll()
      .where('organization_id', '=', organizationId).where('source_command_request_id', '=', commandRequestId)
      .executeTakeFirst()
    return row ? mapEventNote(row) : null
  }

  async createNoteWithOutbox(note: EventNote, domainEvent: DomainEvent): Promise<EventNote> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('event_notes').selectAll()
        .where('organization_id', '=', note.organizationId).where('source_command_request_id', '=', note.sourceCommandRequestId)
        .executeTakeFirst()
      if (existing) return mapEventNote(existing)

      const row = await trx.insertInto('event_notes').values({
        id: note.id,
        organization_id: note.organizationId,
        event_id: note.eventId,
        source_command_request_id: note.sourceCommandRequestId,
        body: note.body,
        created_by_sender: note.createdBySender,
        source: 'command',
        created_at: note.createdAt,
      }).returningAll().executeTakeFirstOrThrow()
      await insertOutbox(trx, domainEvent)
      return mapEventNote(row)
    })
  }
}

async function insertOutbox(trx: Transaction<DatabaseSchema>, domainEvent: DomainEvent): Promise<void> {
  await trx.insertInto('outbox_events').values({
    id: domainEvent.id,
    organization_id: domainEvent.organizationId,
    event_type: domainEvent.eventType,
    aggregate_type: domainEvent.aggregateType,
    aggregate_id: domainEvent.aggregateId,
    payload: domainEvent.payload,
    occurred_at: domainEvent.occurredAt,
    available_at: domainEvent.occurredAt,
    claimed_at: null,
    claimed_by: null,
    dispatched_at: null,
    last_error: null,
  }).execute()
}

function mapCommandRequest(row: Selectable<CommandRequestsTable>): CommandRequest {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sender: row.sender,
    idempotencyKey: row.idempotency_key,
    rawText: row.raw_text,
    explicitEventId: row.explicit_event_id,
    resolvedEventId: row.resolved_event_id,
    interpreter: row.interpreter,
    intent: row.intent,
    confidence: row.confidence,
    status: row.status,
    interpretation: row.interpretation,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processedAt: row.processed_at,
    lastError: row.last_error,
  }
}
function mapConversationContext(row: Selectable<ConversationContextsTable>): ConversationContext {
  return {
    id: row.id, organizationId: row.organization_id, sender: row.sender, currentEventId: row.current_event_id,
    lastInteractionAt: row.last_interaction_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
function mapEventNote(row: Selectable<EventNotesTable>): EventNote {
  return {
    id: row.id, organizationId: row.organization_id, eventId: row.event_id,
    sourceCommandRequestId: row.source_command_request_id, body: row.body,
    createdBySender: row.created_by_sender, source: 'command', createdAt: row.created_at,
  }
}
