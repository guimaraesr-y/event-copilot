import {
  COMMAND_INTENTS,
  CommandInterpreterError,
  type CommandEventOption,
  type CommandInterpretation,
  type CommandInterpreter,
  type CommandInterpreterInput,
  type CommandIntent,
} from '@ecc/domain'
import { scheduleRelativeToReference } from './schedule.ts'

const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const
const COMMAND_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: COMMAND_INTENTS },
    confidence: { type: 'number' },
    eventReference: NULLABLE_STRING,
    taskReference: NULLABLE_STRING,
    taskTitle: NULLABLE_STRING,
    dueAt: NULLABLE_STRING,
    note: NULLABLE_STRING,
    sensitiveField: NULLABLE_STRING,
    sensitiveValue: NULLABLE_STRING,
    rationale: NULLABLE_STRING,
  },
  required: ['intent','confidence','eventReference','taskReference','taskTitle','dueAt','note','sensitiveField','sensitiveValue','rationale'],
} as const

export class RuleBasedCommandInterpreter implements CommandInterpreter {
  readonly kind = 'rule_based' as const

  async interpret(input: CommandInterpreterInput): Promise<CommandInterpretation> {
    const original = input.text.trim()
    const text = normalize(original)
    const eventReference = resolveEventReference(original, input.availableEvents)

    if (isSensitiveChange(text)) {
      const { field, value } = sensitiveChange(text, original)
      return result('SENSITIVE_CHANGE', 0.98, eventReference, { sensitiveField: field, sensitiveValue: value })
    }

    if (/\b(selecione|seleciona|usar|use|trabalhar|focar|foque|abrir|abra)\b/.test(text) && /\b(evento|casamento|festa|aniversario)\b/.test(text)) {
      return result('SET_CURRENT_EVENT', eventReference ? 0.99 : 0.68, eventReference)
    }

    if (/\b(crie|cria|criar|adicione|adiciona|adicionar|nova)\b/.test(text) && /\btarefa\b/.test(text)) {
      const title = extractTaskTitle(original)
      const dueAt = extractDueAt(original, input.now, input.timezone)
      return result('CREATE_TASK', title ? 0.96 : 0.72, eventReference, { taskTitle: title, dueAt })
    }

    if (/\b(conclua|concluir|conclui|complete|completar|finalize|finalizar|marque)\b/.test(text) && /\btarefa\b/.test(text)) {
      return result('COMPLETE_TASK', 0.94, eventReference, { taskReference: extractTaskReference(original) })
    }

    if (/\b(observacao|nota|anote|anota|anotar)\b/.test(text)) {
      return result('ADD_EVENT_NOTE', 0.95, eventReference, { note: extractNote(original) })
    }

    if (/\b(fornecedor|fornecedores)\b/.test(text) && /(penden|nao confirm|a confirmar|faltam confirmar|falta confirmar)/.test(text)) {
      return result('GET_PENDING_VENDORS', 0.97, eventReference)
    }

    if (/\btarefa|tarefas\b/.test(text) && /(abert|penden|falta fazer|o que fazer|o que falta)/.test(text)) {
      return result('GET_OPEN_TASKS', 0.95, eventReference)
    }

    if (/(como esta|status|situacao|resumo|andamento)/.test(text) && /\b(evento|casamento|festa|aniversario)?\b/.test(text)) {
      return result('GET_EVENT_STATUS', 0.96, eventReference)
    }

    return result('UNKNOWN', 0.3, eventReference, { rationale: 'Nenhuma regra determinística reconheceu o comando.' })
  }
}

export interface AICommandInterpreterOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class AICommandInterpreter implements CommandInterpreter {
  readonly kind = 'ai' as const
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: AICommandInterpreterOptions) {
    if (!options.apiKey.trim()) throw new CommandInterpreterError('OPENAI_API_KEY is required when COMMAND_INTERPRETER=ai')
    this.model = options.model?.trim() || 'gpt-5.6'
    this.baseUrl = (options.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async interpret(input: CommandInterpreterInput): Promise<CommandInterpretation> {
    const system = [
      'You classify and extract commands for an event-planning operations system.',
      'Never invent event names, task names, dates, or identifiers. If a request is unclear, use UNKNOWN.',
      'Sensitive changes (event date/time, guest count, venue) must always use SENSITIVE_CHANGE; they are never executed directly.',
      'For CREATE_TASK, dueAt must be RFC3339 when the user supplies enough date/time information; otherwise null.',
      'eventReference should contain the human event name/reference, never an internal UUID unless the user literally supplied it.',
      'Return null for fields that do not apply.',
    ].join(' ')
    const context = {
      text: input.text,
      now: input.now.toISOString(),
      timezone: input.timezone,
      currentEventName: input.currentEventName,
      availableEvents: input.availableEvents.map((event) => ({
        name: event.name,
        type: event.type,
        startAt: event.startAt.toISOString(),
      })),
    }

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions: system,
        input: JSON.stringify(context),
        text: {
          format: {
            type: 'json_schema',
            name: 'ecc_command_interpretation',
            strict: true,
            schema: COMMAND_OUTPUT_SCHEMA,
          },
        },
        max_output_tokens: 1200,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new CommandInterpreterError(`OpenAI Responses API returned ${response.status}: ${body.slice(0, 500)}`)
    }

    const payload = await response.json() as any
    if (payload.status === 'incomplete') {
      throw new CommandInterpreterError(`OpenAI response incomplete: ${JSON.stringify(payload.incomplete_details ?? {})}`)
    }
    const refusal = findContent(payload, 'refusal')
    if (refusal) throw new CommandInterpreterError(`OpenAI refused command interpretation: ${String(refusal.refusal ?? refusal.text ?? 'refused')}`)
    const outputText = findContent(payload, 'output_text')?.text
    if (typeof outputText !== 'string' || !outputText.trim()) {
      throw new CommandInterpreterError('OpenAI response did not contain structured output text')
    }

    let parsed: unknown
    try { parsed = JSON.parse(outputText) } catch { throw new CommandInterpreterError('OpenAI structured output was not valid JSON') }
    return validateInterpretation(parsed)
  }
}

function findContent(payload: any, type: string): any | null {
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === type) return content
    }
  }
  return null
}

export function validateInterpretation(value: unknown): CommandInterpretation {
  if (!value || typeof value !== 'object') throw new CommandInterpreterError('Command interpretation must be an object')
  const v = value as Record<string, unknown>
  if (typeof v.intent !== 'string' || !(COMMAND_INTENTS as readonly string[]).includes(v.intent)) {
    throw new CommandInterpreterError('Command interpretation contains an invalid intent')
  }
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
    throw new CommandInterpreterError('Command interpretation contains an invalid confidence')
  }
  const readNullable = (key: string): string | null => {
    const item = v[key]
    if (item === null) return null
    if (typeof item !== 'string') throw new CommandInterpreterError(`Command interpretation field ${key} must be string|null`)
    return item.trim() || null
  }
  return {
    intent: v.intent as CommandIntent,
    confidence: v.confidence,
    eventReference: readNullable('eventReference'),
    taskReference: readNullable('taskReference'),
    taskTitle: readNullable('taskTitle'),
    dueAt: readNullable('dueAt'),
    note: readNullable('note'),
    sensitiveField: readNullable('sensitiveField'),
    sensitiveValue: readNullable('sensitiveValue'),
    rationale: readNullable('rationale'),
  }
}

function result(
  intent: CommandIntent,
  confidence: number,
  eventReference: string | null,
  patch: Partial<Omit<CommandInterpretation,'intent'|'confidence'|'eventReference'>> = {},
): CommandInterpretation {
  return {
    intent, confidence, eventReference,
    taskReference: patch.taskReference ?? null,
    taskTitle: patch.taskTitle ?? null,
    dueAt: patch.dueAt ?? null,
    note: patch.note ?? null,
    sensitiveField: patch.sensitiveField ?? null,
    sensitiveValue: patch.sensitiveValue ?? null,
    rationale: patch.rationale ?? null,
  }
}

function resolveEventReference(text: string, events: CommandEventOption[]): string | null {
  const normalized = normalize(text)
  const scored = events.map((event) => ({ event, score: nameScore(event.name, normalized) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a,b) => b.score-a.score)
  if (!scored[0]) return null
  if (scored[1] && scored[1].score === scored[0].score) return null
  return scored[0].event.name
}

function nameScore(name: string, normalizedText: string): number {
  const normalizedName = normalize(name)
  if (normalizedText.includes(normalizedName)) return 100
  const stop = new Set(['casamento','evento','festa','aniversario','corporativo','de','da','do','dos','das','e'])
  const tokens = normalizedName.split(/\s+/).filter((t) => t.length >= 3 && !stop.has(t))
  return tokens.reduce((score, token) => score + (normalizedText.includes(token) ? 10 : 0), 0)
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9:&\s-]/g,' ').replace(/\s+/g,' ').trim()
}

function isSensitiveChange(text: string): boolean {
  const mutation = /\b(mude|muda|mudar|altere|altera|alterar|troque|troca|trocar|ajuste|ajusta|ajustar)\b/.test(text)
  const field = /\b(data|dia|horario|hora|convidados|convidado|local|espaco|endereco)\b/.test(text)
  return mutation && field
}
function sensitiveChange(text: string, original: string): { field: string; value: string | null } {
  if (/\b(convidados|convidado)\b/.test(text)) return { field: 'guest_count', value: original.match(/\b\d+\b/)?.[0] ?? null }
  if (/\b(local|espaco|endereco)\b/.test(text)) return { field: 'venue', value: original }
  if (/\b(horario|hora)\b/.test(text)) return { field: 'event_time', value: original.match(/\b\d{1,2}(?::\d{2}|h\d{0,2})?\b/i)?.[0] ?? null }
  if (/\b(data|dia)\b/.test(text)) return { field: 'event_date', value: original }
  return { field: 'other', value: original }
}

function extractTaskTitle(text: string): string | null {
  const cleaned = text.trim().replace(/[.!?]+$/,'')
  const para = cleaned.match(/\btarefa\b[\s\S]*?\bpara\s+(.+)$/i)
  if (para?.[1]) return cleanTaskTitle(para[1])
  const after = cleaned.match(/\btarefa\b\s*(?:de|:|-)?\s*(.+)$/i)
  return after?.[1] ? cleanTaskTitle(after[1]) : null
}
function cleanTaskTitle(value: string): string | null {
  const stripped = value
    .replace(/\s+(?:depois de amanh[ãa]|amanh[ãa]|hoje)(?:\s+(?:[àa]s?\s+)?\d{1,2}(?::\d{2}|h\d{0,2})?)?\s*$/i, '')
    .replace(/\s+(?:[àa]s?\s+)\d{1,2}(?::\d{2}|h\d{0,2})?\s*$/i, '')
    .trim()
  return stripped || null
}
function extractTaskReference(text: string): string | null {
  const cleaned = text.trim().replace(/[.!?]+$/,'')
  return cleaned.match(/\btarefa\b\s*(?:de|:|-)?\s*(.+)$/i)?.[1]?.trim() || cleaned
}
function extractNote(text: string): string | null {
  const patterns = [
    /\bobserva[cç][aã]o\b\s*(?:dizendo que|de que|:|-)?\s*(.+)$/i,
    /\b(?:anote|anota|anotar)\b\s*(?:que|:|-)?\s*(.+)$/i,
    /\bnota\b\s*(?:dizendo que|de que|:|-)?\s*(.+)$/i,
  ]
  for (const p of patterns) { const m=text.match(p); if (m?.[1]?.trim()) return m[1].trim().replace(/[.!?]+$/,'') }
  return null
}
function extractDueAt(text: string, now: Date, timezone: string): string | null {
  const normalized = normalize(text)
  let offset: number | null = null
  if (/\bdepois de amanha\b/.test(normalized)) offset = 2
  else if (/\bamanha\b/.test(normalized)) offset = 1
  else if (/\bhoje\b/.test(normalized)) offset = 0
  if (offset === null) return null

  const timeMatch = text.match(/(?:[àa]s?\s+)?\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)\b/i)
  const hour = timeMatch ? Number(timeMatch[1]) : 9
  const minute = timeMatch ? Number(timeMatch[2] ?? timeMatch[3] ?? 0) : 0
  const due = scheduleRelativeToReference(now, offset, `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`, timezone)
  return due.toISOString()
}
