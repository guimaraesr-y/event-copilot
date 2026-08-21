import type { Hono } from 'hono'
import { z } from 'zod'
import { operationalAgentMessageSchema } from '@ecc/contracts'
import type { OrganizationRepository } from '@ecc/database'
import type { AgentTurn, AgentTurnStore } from '@ecc/domain'
import {
  BriefNotFoundError,
  BriefValidationError,
  EventDayConflictError,
  EventDayNotFoundError,
  EventDayValidationError,
  OperationalAgentConflictError,
  OperationalAgentLoopError,
  OperationalAgentProviderError,
  OperationalAgentValidationError,
} from '@ecc/domain'
import type { BriefEngine, OperationalAgent } from '@ecc/event-engine'

export function registerOperationalAgentRoutes(
  app: Hono,
  organizations: OrganizationRepository,
  agent: OperationalAgent,
  briefEngine: BriefEngine,
  agentStore: AgentTurnStore,
): void {
  app.post('/api/v1/agent/messages', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const body = await c.req.json().catch(() => null)
    const parsed = operationalAgentMessageSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid operational agent payload', issues: parsed.error.issues } }, 400)

    const agentInput = {
      organizationId: context.organization.id,
      organizationTimezone: context.organization.timezone,
      sender: parsed.data.sender,
      text: parsed.data.text,
      idempotencyKey: parsed.data.idempotencyKey,
      explicitEventId: parsed.data.eventId ?? null,
    }

    try {
      const recent = await agentStore.listRecentTurns(context.organization.id, parsed.data.sender, 1)
      const previous = recent.at(-1) ?? null
      const pendingBriefGeneration = previous ? awaitsDailyBriefGenerationConfirmation(previous) : false

      if ((pendingBriefGeneration && isBriefGenerationConfirmation(parsed.data.text)) || isExplicitDailyBriefGeneration(parsed.data.text)) {
        const result = await generateDailyBriefWithoutModel({
          organizationId: context.organization.id,
          sender: parsed.data.sender,
          text: parsed.data.text,
          idempotencyKey: parsed.data.idempotencyKey,
          explicitEventId: parsed.data.eventId ?? null,
          briefEngine,
          agentStore,
          confirmedFromTurnId: pendingBriefGeneration ? previous?.id ?? null : null,
        })
        return c.json({ data: { turn: serializeTurn(result.turn), duplicate: result.duplicate, reply: result.reply } }, result.duplicate ? 200 : 201)
      }

      if (pendingBriefGeneration && isBriefGenerationDecline(parsed.data.text)) {
        const result = await completeWithoutModel({
          organizationId: context.organization.id,
          sender: parsed.data.sender,
          text: parsed.data.text,
          idempotencyKey: parsed.data.idempotencyKey,
          explicitEventId: parsed.data.eventId ?? null,
          reply: 'Certo. Não gerei um novo Daily Brief.',
          toolTrace: [],
          agentStore,
        })
        return c.json({ data: { turn: serializeTurn(result.turn), duplicate: result.duplicate, reply: result.reply } }, result.duplicate ? 200 : 201)
      }

      const result = await agent.chat(agentInput)
      return c.json({ data: { turn: serializeTurn(result.turn), duplicate: result.duplicate, reply: result.reply } }, result.duplicate ? 200 : 201)
    } catch (error) {
      if (error instanceof BriefNotFoundError && error.message === 'Daily brief has not been generated yet') {
        const result = await convertMissingBriefTurnToConfirmation({
          organizationId: context.organization.id,
          sender: parsed.data.sender,
          text: parsed.data.text,
          idempotencyKey: parsed.data.idempotencyKey,
          explicitEventId: parsed.data.eventId ?? null,
          agentStore,
        })
        return c.json({ data: { turn: serializeTurn(result.turn), duplicate: false, reply: result.reply } }, 201)
      }
      return mapError(c, error)
    }
  })

  app.get('/api/v1/agent/history', async (c) => {
    const context = await organizationContext(c, organizations)
    if ('response' in context) return context.response
    const sender = c.req.query('sender')?.trim()
    if (!sender) return c.json({ error: { code: 'SENDER_REQUIRED', message: 'sender query parameter is required' } }, 400)
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '10', 10)
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : 10
    const turns = await agent.history(context.organization.id, sender, limit)
    return c.json({ data: turns.map(serializeTurn) })
  })
}

async function organizationContext(c: any, organizations: OrganizationRepository): Promise<any> {
  const organizationId = c.req.header('x-organization-id')
  if (!organizationId || !z.uuid().safeParse(organizationId).success) {
    return { response: c.json({ error: { code: 'INVALID_ORGANIZATION_ID', message: 'A valid x-organization-id is required' } }, 400) }
  }
  const organization = await organizations.findById(organizationId)
  if (!organization) return { response: c.json({ error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' } }, 404) }
  return { organization }
}

interface FastTurnInput {
  organizationId: string
  sender: string
  text: string
  idempotencyKey: string
  explicitEventId: string | null
  reply: string
  toolTrace: AgentTurn['toolTrace']
  agentStore: AgentTurnStore
}

async function completeWithoutModel(input: FastTurnInput): Promise<{ turn: AgentTurn; duplicate: boolean; reply: string }> {
  const now = new Date()
  const created = await input.agentStore.createTurnIfAbsent({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    sender: input.sender,
    idempotencyKey: input.idempotencyKey,
    userText: input.text,
    explicitEventId: input.explicitEventId,
    provider: 'deterministic',
    model: 'server-fast-path',
    now,
  })

  if (!created.created) {
    const samePayload = created.turn.sender === input.sender
      && created.turn.userText === input.text
      && created.turn.explicitEventId === input.explicitEventId
    if (!samePayload) throw new OperationalAgentConflictError('idempotencyKey was already used for a different agent message')
    if (created.turn.status === 'completed' && created.turn.assistantText) {
      return { turn: created.turn, duplicate: true, reply: created.turn.assistantText }
    }
    throw new OperationalAgentConflictError(`Agent turn already exists with status ${created.turn.status}; use a new idempotencyKey after reviewing the previous turn`)
  }

  const completedAt = new Date()
  const turn = await input.agentStore.updateTurn(input.organizationId, created.turn.id, {
    assistantText: input.reply,
    status: 'completed',
    modelCalls: 0,
    toolTrace: input.toolTrace,
    completedAt,
    updatedAt: completedAt,
    lastError: null,
  })
  return { turn, duplicate: false, reply: input.reply }
}

async function generateDailyBriefWithoutModel(input: {
  organizationId: string
  sender: string
  text: string
  idempotencyKey: string
  explicitEventId: string | null
  briefEngine: BriefEngine
  agentStore: AgentTurnStore
  confirmedFromTurnId: string | null
}): Promise<{ turn: AgentTurn; duplicate: boolean; reply: string }> {
  const now = new Date()
  const created = await input.agentStore.createTurnIfAbsent({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    sender: input.sender,
    idempotencyKey: input.idempotencyKey,
    userText: input.text,
    explicitEventId: input.explicitEventId,
    provider: 'deterministic',
    model: 'server-fast-path',
    now,
  })

  if (!created.created) {
    const samePayload = created.turn.sender === input.sender
      && created.turn.userText === input.text
      && created.turn.explicitEventId === input.explicitEventId
    if (!samePayload) throw new OperationalAgentConflictError('idempotencyKey was already used for a different agent message')
    if (created.turn.status === 'completed' && created.turn.assistantText) {
      return { turn: created.turn, duplicate: true, reply: created.turn.assistantText }
    }
    throw new OperationalAgentConflictError(`Agent turn already exists with status ${created.turn.status}; use a new idempotencyKey after reviewing the previous turn`)
  }

  try {
    const generated = await input.briefEngine.generateDaily({
      organizationId: input.organizationId,
      triggerType: 'agent',
      triggerKey: `agent:${created.turn.id}:daily-brief-fast-path`,
      generatedBySender: input.sender,
    })
    const reply = `Daily Brief gerado agora:\n\n${generated.brief.renderedText}`
    const completedAt = new Date()
    const turn = await input.agentStore.updateTurn(input.organizationId, created.turn.id, {
      assistantText: reply,
      status: 'completed',
      modelCalls: 0,
      toolTrace: [{
        index: 1,
        name: 'generate_daily_brief',
        arguments: input.confirmedFromTurnId ? { confirmedFromTurnId: input.confirmedFromTurnId } : {},
        result: {
          duplicate: generated.duplicate,
          briefId: generated.brief.id,
          referenceDate: generated.brief.referenceDate,
          revision: generated.brief.revision,
          priorities: generated.brief.summary.priorities.length,
          activeEvents: generated.brief.summary.activeEvents,
        },
      }],
      completedAt,
      updatedAt: completedAt,
      lastError: null,
    })
    return { turn, duplicate: false, reply }
  } catch (error) {
    const failedAt = new Date()
    await input.agentStore.updateTurn(input.organizationId, created.turn.id, {
      status: 'failed',
      modelCalls: 0,
      toolTrace: [],
      completedAt: failedAt,
      updatedAt: failedAt,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
    throw error
  }
}

async function convertMissingBriefTurnToConfirmation(input: {
  organizationId: string
  sender: string
  text: string
  idempotencyKey: string
  explicitEventId: string | null
  agentStore: AgentTurnStore
}): Promise<{ turn: AgentTurn; reply: string }> {
  // OperationalAgent already created the turn before BriefEngine.getToday() failed.
  // Reusing the same idempotency key retrieves that failed turn without inserting a second one.
  const existing = await input.agentStore.createTurnIfAbsent({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    sender: input.sender,
    idempotencyKey: input.idempotencyKey,
    userText: input.text,
    explicitEventId: input.explicitEventId,
    provider: 'deterministic',
    model: 'server-recovery',
    now: new Date(),
  })
  const reply = 'O Daily Brief de hoje ainda não foi gerado. Quer que eu gere uma versão agora?'
  const completedAt = new Date()
  const turn = await input.agentStore.updateTurn(input.organizationId, existing.turn.id, {
    assistantText: reply,
    status: 'completed',
    modelCalls: existing.turn.modelCalls,
    toolTrace: [{
      index: 1,
      name: 'get_daily_brief',
      arguments: {},
      result: {
        available: false,
        reason: 'not_generated',
        needsGenerationConfirmation: true,
      },
    }],
    completedAt,
    updatedAt: completedAt,
    lastError: null,
  })
  return { turn, reply }
}

function awaitsDailyBriefGenerationConfirmation(turn: AgentTurn): boolean {
  const last = [...turn.toolTrace].reverse().find((entry) => entry.name === 'get_daily_brief')
  return last?.result?.needsGenerationConfirmation === true
}

function normalizeDecisionText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function isBriefGenerationConfirmation(text: string): boolean {
  const n = normalizeDecisionText(text).replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (/\b(nao|cancela|deixa|melhor nao)\b/.test(n)) return false
  return /^(sim(?: pode gerar)?|pode|pode gerar|gera|gere|gerar|claro(?: pode gerar)?|quero|manda|pode fazer)$/.test(n)
}

function isBriefGenerationDecline(text: string): boolean {
  const n = normalizeDecisionText(text).replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim()
  return /^(nao|nao precisa|melhor nao|deixa|deixa pra la|cancela)$/.test(n)
}

function isExplicitDailyBriefGeneration(text: string): boolean {
  const n = normalizeDecisionText(text)
  if (/\b(nao|cancela|cancelar)\b/.test(n)) return false
  if (!/\b(brief|resumo)\b/.test(n)) return false
  if (!/\b(hoje|diario|daily)\b/.test(n)) return false
  return /\b(gere|gera|gerar|crie|cria|criar|monte|monta|montar|refaca|refazer|pode gerar|pode criar)\b/.test(n)
}

function serializeTurn(turn: any) {
  return {
    ...turn,
    createdAt: turn.createdAt.toISOString(),
    updatedAt: turn.updatedAt.toISOString(),
    completedAt: turn.completedAt?.toISOString() ?? null,
  }
}
function mapError(c: any, error: unknown) {
  if (error instanceof OperationalAgentConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409)
  if (error instanceof OperationalAgentValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  if (error instanceof BriefNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404)
  if (error instanceof BriefValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  if (error instanceof EventDayNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404)
  if (error instanceof EventDayConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409)
  if (error instanceof EventDayValidationError) return c.json({ error: { code: error.code, message: error.message } }, 422)
  if (error instanceof OperationalAgentProviderError) return c.json({ error: { code: error.code, message: error.message } }, 502)
  if (error instanceof OperationalAgentLoopError) return c.json({ error: { code: error.code, message: error.message } }, 502)
  throw error
}
