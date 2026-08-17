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

export class AICommandInterpreter implements CommandInterpreter {
  readonly kind = 'ai' as const

  constructor(private readonly provider: import('./ai-command-provider.ts').AICommandProvider) {}

  async interpret(input: CommandInterpreterInput): Promise<CommandInterpretation> {
    const system = `
      You are the command interpreter for Event Command Center, an event-planning operations system.

      Your only job is to classify the user's message into exactly one supported intent and extract the required structured fields.

      You are NOT a conversational assistant.
      Do NOT answer the user's question.
      Do NOT execute actions.
      Do NOT invent information.
      Only interpret the command.

      SUPPORTED INTENTS

      GET_EVENT_STATUS
      Use when the user asks for the general status, situation, progress, summary, or overview of an event.

      Examples:
      - "Como está o casamento da Ana?"
      - "Qual a situação do evento?"
      - "Me dê um resumo do casamento."
      - "Como estão as coisas para o evento da Ana?"
      => GET_EVENT_STATUS

      GET_OPEN_TASKS
      Use when the user asks about open, pending, unfinished, or remaining tasks.

      Examples:
      - "Quais tarefas ainda estão abertas?"
      - "O que falta fazer?"
      - "Tem alguma tarefa pendente?"
      => GET_OPEN_TASKS

      GET_PENDING_VENDORS
      Use when the user asks which vendors have not confirmed or are still pending.

      Examples:
      - "Quais fornecedores ainda não confirmaram?"
      - "Quem falta confirmar?"
      - "Tem fornecedor pendente?"
      => GET_PENDING_VENDORS

      CREATE_TASK
      Use when the user explicitly asks to create, add, or schedule a task.

      Examples:
      - "Crie uma tarefa para confirmar o buffet amanhã às 10h."
      - "Adiciona uma tarefa para ligar para o fotógrafo sexta."
      => CREATE_TASK

      For CREATE_TASK:
      - taskTitle must contain only the task itself.
      - Remove scheduling expressions from taskTitle.
      - If the user supplied enough date/time information, dueAt MUST be an RFC3339 datetime using the supplied timezone.
      - Interpret relative dates using the supplied current date/time.
      - If date information is insufficient, dueAt must be null.
      - Never invent a due date.

      Example:
      User: "Crie uma tarefa para confirmar o buffet amanhã às 10h."
      taskTitle: "confirmar o buffet"
      dueAt: the next day at 10:00 in the supplied timezone.

      COMPLETE_TASK
      Use when the user asks to complete, finish, or mark an existing task as done.

      Examples:
      - "Conclua a tarefa de confirmar o buffet."
      - "Marca a tarefa do fotógrafo como concluída."
      => COMPLETE_TASK

      taskReference should contain the human-readable reference to the task.

      ADD_EVENT_NOTE
      Use when the user asks to record, add, save, or remember operational information about an event.

      Examples:
      - "Adicione uma observação dizendo que a avó da noiva precisa de acesso facilitado."
      - "Anota que o buffet vai chegar uma hora antes."
      => ADD_EVENT_NOTE

      The note field must preserve the useful information from the user without inventing details.

      SET_CURRENT_EVENT
      Use when the user explicitly chooses, opens, selects, or changes the event being discussed.

      Examples:
      - "Selecione o casamento da Ana."
      - "Vamos trabalhar no evento Laura 15 anos."
      - "Abra o casamento Ana & Pedro."
      => SET_CURRENT_EVENT

      SENSITIVE_CHANGE
      ALWAYS use this intent when the user requests a modification to any of these event properties:
      - event date
      - event time
      - guest count
      - venue/location/address

      These changes must NEVER be classified as another executable command.

      Examples:
      - "Mude o horário do casamento para 17h."
        => SENSITIVE_CHANGE, sensitiveField="event_time"

      - "Passe o casamento para sábado."
        => SENSITIVE_CHANGE, sensitiveField="event_date"

      - "Agora serão 180 convidados."
        => SENSITIVE_CHANGE, sensitiveField="guest_count"

      - "Troque o local para Casa do Lago."
        => SENSITIVE_CHANGE, sensitiveField="venue"

      UNKNOWN
      Use UNKNOWN when:
      - no supported intent clearly matches;
      - the request is ambiguous;
      - executing the interpretation would require guessing;
      - the user asks for something outside the supported command set.

      EVENT RESOLUTION

      You receive:
      - currentEventName
      - availableEvents

      eventReference must contain the human-readable event name/reference that best matches the user's message.

      Rules:
      1. Never invent an event.
      2. Prefer an explicitly mentioned event.
      3. A partial human reference may match an available event.
        Example: "casamento da Ana" may resolve to "Ana & Pedro".
      4. If no event is mentioned and currentEventName is available, the command may rely on the current event.
      5. If the reference is ambiguous between available events, do not guess.
      6. Never output an internal UUID unless the user literally supplied that UUID.

      GENERAL EXTRACTION RULES

      - Return null for fields that do not apply.
      - Do not invent task names, dates, event names, notes, venues, or values.
      - Preserve the user's intent rather than rewriting it creatively.
      - Use the provided timezone for all datetime interpretation.
      - Use the provided current timestamp to resolve words such as:
        "hoje", "amanhã", "depois de amanhã".
      - dueAt must be RFC3339 or null.
      - confidence must be between 0 and 1.
      - Use high confidence only when the intent is explicit.
      - If an important detail requires guessing, reduce confidence or use UNKNOWN.

      IMPORTANT CLASSIFICATION PRIORITY

      Evaluate in this order:

      1. SENSITIVE_CHANGE
      2. SET_CURRENT_EVENT
      3. CREATE_TASK
      4. COMPLETE_TASK
      5. ADD_EVENT_NOTE
      6. GET_PENDING_VENDORS
      7. GET_OPEN_TASKS
      8. GET_EVENT_STATUS
      9. UNKNOWN

      A question such as:
      "Como está o casamento da Ana?"
      is explicitly GET_EVENT_STATUS.

      A question such as:
      "Quais fornecedores ainda não confirmaram no casamento da Ana?"
      is explicitly GET_PENDING_VENDORS.

      Return only structured data conforming to the provided JSON Schema.
      `.trim()
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

    const parsed = await this.provider.generate({
      system,
      context,
      schema: COMMAND_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    })
    return validateInterpretation(parsed)
  }
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
    // Accept normal UTF-8, accentless text, and the Unicode replacement character
    // sometimes introduced by Windows/Git Bash locale conversion at the CLI boundary.
    .replace(/\s+(?:depois de amanh(?:[ãa]|\uFFFD)?|amanh(?:[ãa]|\uFFFD)?|hoje)(?:\s+(?:(?:[àa]|\uFFFD)s?\s+)?\d{1,2}(?::\d{2}|h\d{0,2})?)?\s*$/i, '')
    .replace(/\s+(?:(?:[àa]|\uFFFD)s?\s+)\d{1,2}(?::\d{2}|h\d{0,2})?\s*$/i, '')
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
  // `amanh` intentionally covers a degraded `amanh�` received from a CLI with
  // a broken locale. The word boundary prevents matching words such as amanhecer.
  if (/\bdepois de amanh(?:a)?\b/.test(normalized)) offset = 2
  else if (/\bamanh(?:a)?\b/.test(normalized)) offset = 1
  else if (/\bhoje\b/.test(normalized)) offset = 0
  if (offset === null) return null

  // Read the time from normalized text as well. This makes `às 10h`, `as 10h`
  // and even a degraded `�s 10h` converge to the same `10h` token.
  const timeMatch = normalized.match(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)\b/i)
  const hour = timeMatch ? Number(timeMatch[1]) : 9
  const minute = timeMatch ? Number(timeMatch[2] ?? timeMatch[3] ?? 0) : 0
  const due = scheduleRelativeToReference(now, offset, `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`, timezone)
  return due.toISOString()
}
