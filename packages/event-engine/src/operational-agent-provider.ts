import { OperationalAgentProviderError, type OperationalAgentProviderKind } from '@ecc/domain'

export interface AgentToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentToolCall {
  id?: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
}

export interface AgentProviderResponse {
  message: AgentProviderMessage
  toolCalls: AgentToolCall[]
}

export interface OperationalAgentProvider {
  readonly kind: OperationalAgentProviderKind
  readonly model: string
  complete(input: {
    messages: AgentProviderMessage[]
    tools: AgentToolDefinition[]
    sessionId?: string
  }): Promise<AgentProviderResponse>
}


export type OpenRouterAgentToolMode = 'prompt' | 'native'

export interface OpenRouterOperationalAgentProviderOptions {
  apiKey?: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  toolMode?: OpenRouterAgentToolMode
  httpReferer?: string
  appTitle?: string
  requireParameters?: boolean
  dataCollection?: 'allow' | 'deny'
  fetchImpl?: typeof fetch
}

export class OpenRouterOperationalAgentProvider implements OperationalAgentProvider {
  readonly kind = 'openrouter' as const
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly toolMode: OpenRouterAgentToolMode
  private readonly httpReferer: string | null
  private readonly appTitle: string | null
  private readonly requireParameters: boolean
  private readonly dataCollection: 'allow' | 'deny'
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenRouterOperationalAgentProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || ''
    this.model = options.model?.trim() || 'openrouter/auto'
    this.baseUrl = (options.baseUrl?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.toolMode = options.toolMode ?? 'native'
    this.httpReferer = options.httpReferer?.trim() || null
    this.appTitle = options.appTitle?.trim() || null
    this.requireParameters = options.requireParameters ?? true
    this.dataCollection = options.dataCollection ?? 'allow'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async complete(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    if (!this.apiKey) throw new OperationalAgentProviderError('OPENROUTER_API_KEY is required when OPERATIONAL_AGENT_PROVIDER=openrouter')
    return this.toolMode === 'native' ? this.completeNative(input) : this.completePrompt(input)
  }

  private async completeNative(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    const response = await this.request({
      model: this.model,
      stream: false,
      temperature: 0,
      messages: input.messages.map(toOpenRouterMessage),
      tools: input.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
      provider: this.providerPreferences(),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    })
    const rawMessage = response?.choices?.[0]?.message
    if (!rawMessage || typeof rawMessage !== 'object') throw new OperationalAgentProviderError('OpenRouter response did not contain choices[0].message')
    const toolCalls = (Array.isArray(rawMessage.tool_calls) ? rawMessage.tool_calls : []).map((call: any): AgentToolCall => {
      const id = typeof call?.id === 'string' && call.id.trim() ? call.id : null
      if (!id) throw new OperationalAgentProviderError('OpenRouter native tool call did not contain an id')
      return {
        id,
        name: requireToolName(call?.function?.name),
        arguments: parseToolArguments(call?.function?.arguments),
      }
    })
    const content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    return {
      message: { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) },
      toolCalls,
    }
  }

  private async completePrompt(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    const messages = buildPromptProtocolMessages(input)
    const response = await this.request({
      model: this.model,
      stream: false,
      temperature: 0,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ecc_operational_agent_action', strict: true, schema: ACTION_SCHEMA },
      },
      provider: this.providerPreferences(),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    })
    const content = response?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new OperationalAgentProviderError('OpenRouter prompt-agent response did not contain message.content')
    let action: any
    try { action = JSON.parse(content) } catch { throw new OperationalAgentProviderError('OpenRouter prompt-agent response was not valid JSON') }
    return parsePromptAction(action, input.tools, 'OpenRouter')
  }

  private providerPreferences(): Record<string, unknown> {
    return { require_parameters: this.requireParameters, data_collection: this.dataCollection }
  }

  private async request(body: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    }
    if (this.httpReferer) headers['HTTP-Referer'] = this.httpReferer
    if (this.appTitle) headers['X-OpenRouter-Title'] = this.appTitle
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new OperationalAgentProviderError(`OpenRouter request failed: ${reason}`)
    }
    if (!response.ok) {
      const responseBody = await response.text()
      throw new OperationalAgentProviderError(`OpenRouter API returned ${response.status}: ${responseBody.slice(0, 800)}`)
    }
    return response.json()
  }
}

function toOpenRouterMessage(message: AgentProviderMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    if (!message.toolCallId) throw new OperationalAgentProviderError('OpenRouter native tool result is missing toolCallId')
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  const mapped: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    mapped.tool_calls = message.toolCalls.map((call) => {
      if (!call.id) throw new OperationalAgentProviderError('OpenRouter assistant tool call is missing id')
      return { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }
    })
  }
  return mapped
}

export type OllamaAgentToolMode = 'prompt' | 'native'

export interface OllamaOperationalAgentProviderOptions {
  model?: string
  baseUrl?: string
  timeoutMs?: number
  keepAlive?: string
  toolMode?: OllamaAgentToolMode
  fetchImpl?: typeof fetch
}

const ACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['type','toolName','arguments','answer'],
  properties: {
    type: { type: 'string', enum: ['tool','final'] },
    toolName: { type: ['string','null'] },
    arguments: { type: 'object' },
    answer: { type: ['string','null'] },
  },
}

export class OllamaOperationalAgentProvider implements OperationalAgentProvider {
  readonly kind = 'ollama' as const
  readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly keepAlive: string
  private readonly toolMode: OllamaAgentToolMode
  private readonly fetchImpl: typeof fetch

  constructor(options: OllamaOperationalAgentProviderOptions = {}) {
    this.model = options.model?.trim() || 'qwen3:4b'
    this.baseUrl = (options.baseUrl?.trim() || 'http://ollama:11434').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.keepAlive = options.keepAlive?.trim() || '10m'
    this.toolMode = options.toolMode ?? 'prompt'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async complete(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    return this.toolMode === 'native' ? this.completeNative(input) : this.completePrompt(input)
  }

  private async completeNative(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        keep_alive: this.keepAlive,
        options: { temperature: 0 },
        messages: input.messages.map(toOllamaMessage),
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new OperationalAgentProviderError(`Ollama agent API returned ${response.status}: ${body.slice(0, 500)}`)
    }
    const payload = await response.json() as any
    const rawMessage = payload?.message
    if (!rawMessage || typeof rawMessage !== 'object') throw new OperationalAgentProviderError('Ollama agent response did not contain message')
    const toolCalls = (Array.isArray(rawMessage.tool_calls) ? rawMessage.tool_calls : []).map((call: any, index: number): AgentToolCall => ({
      ...(typeof call?.id === 'string' ? { id: call.id } : {}),
      name: requireToolName(call?.function?.name),
      arguments: objectValue(call?.function?.arguments),
    }))
    const message: AgentProviderMessage = {
      role: 'assistant',
      content: typeof rawMessage.content === 'string' ? rawMessage.content : '',
      ...(toolCalls.length ? { toolCalls } : {}),
    }
    return { message, toolCalls }
  }

  private async completePrompt(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    const messages = buildPromptProtocolMessages(input)

    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        keep_alive: this.keepAlive,
        format: ACTION_SCHEMA,
        options: { temperature: 0 },
        messages,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new OperationalAgentProviderError(`Ollama agent API returned ${response.status}: ${body.slice(0, 500)}`)
    }
    const payload = await response.json() as any
    const content = payload?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new OperationalAgentProviderError('Ollama prompt-agent response did not contain message.content')
    let action: any
    try { action = JSON.parse(content) } catch { throw new OperationalAgentProviderError('Ollama prompt-agent response was not valid JSON') }
    return parsePromptAction(action, input.tools, 'Ollama')
  }
}


function buildPromptProtocolMessages(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[] }): Array<{ role: string; content: string }> {
  const toolCatalog = input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  const systemAddon = [
    'TOOL LOOP PROTOCOL:',
    'You do not have native function calling in this mode. Choose exactly one next action.',
    'To call a tool, return type="tool", toolName with an exact available tool name, arguments matching its schema, answer=null.',
    'To answer the user, return type="final", toolName=null, arguments={}, answer with the final answer.',
    'Never claim a tool succeeded before receiving its tool result.',
    `Available tools: ${JSON.stringify(toolCatalog)}`,
  ].join('\n')
  const messages = input.messages.map((message) => {
    if (message.role === 'tool') return { role: 'user', content: `[TOOL RESULT ${message.toolName ?? 'unknown'}]\n${message.content}` }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return { role: 'assistant', content: message.content || `[TOOL REQUEST]\n${JSON.stringify(message.toolCalls)}` }
    }
    return { role: message.role, content: message.content }
  })
  const firstSystem = messages.findIndex((message) => message.role === 'system')
  if (firstSystem >= 0) messages[firstSystem] = { role: 'system', content: `${messages[firstSystem]!.content}\n\n${systemAddon}` }
  else messages.unshift({ role: 'system', content: systemAddon })
  return messages
}

function parsePromptAction(action: any, tools: AgentToolDefinition[], providerName: string): AgentProviderResponse {
  if (action?.type === 'final') {
    const answer = typeof action.answer === 'string' ? action.answer.trim() : ''
    if (!answer) throw new OperationalAgentProviderError(`${providerName} prompt-agent final action did not contain an answer`)
    return { message: { role: 'assistant', content: answer }, toolCalls: [] }
  }
  if (action?.type !== 'tool') throw new OperationalAgentProviderError(`${providerName} prompt-agent action type must be tool or final`)
  const name = requireToolName(action.toolName)
  if (!tools.some((tool) => tool.name === name)) throw new OperationalAgentProviderError(`${providerName} requested unknown tool: ${name}`)
  const toolCall: AgentToolCall = { name, arguments: objectValue(action.arguments) }
  return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, toolCalls: [toolCall] }
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return objectValue(JSON.parse(value)) } catch { throw new OperationalAgentProviderError('Agent provider returned invalid JSON tool arguments') }
  }
  return objectValue(value)
}

function toOllamaMessage(message: AgentProviderMessage): Record<string, unknown> {
  const mapped: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.role === 'tool' && message.toolName) mapped.tool_name = message.toolName
  if (message.role === 'assistant' && message.toolCalls?.length) {
    mapped.tool_calls = message.toolCalls.map((call, index) => ({
      type: 'function',
      function: { index, name: call.name, arguments: call.arguments },
    }))
  }
  return mapped
}

function requireToolName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new OperationalAgentProviderError('Agent provider returned an invalid tool name')
  return value
}
function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Deterministic provider for smoke/CI only. Never selected by default in production. */
export class DeterministicOperationalAgentProvider implements OperationalAgentProvider {
  readonly kind = 'deterministic' as const
  readonly model = 'deterministic-smoke'

  async complete(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[]; sessionId?: string }): Promise<AgentProviderResponse> {
    const last = input.messages[input.messages.length - 1]
    if (last?.role === 'tool') {
      const message: AgentProviderMessage = { role: 'assistant', content: `Operação concluída com ${last.toolName ?? 'ferramenta'}.` }
      return { message, toolCalls: [] }
    }
    const user = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
    const normalized = user.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    // Smoke/CI may run through Git Bash/MSYS, where an accented UTF-8 byte sequence can
    // occasionally reach the API with U+FFFD. Keep the deterministic provider tolerant
    // to that transport degradation; production AI providers still receive the raw text.
    const healthTerm = /health|sa(?:u|\uFFFD)de/.test(normalized)
    if (normalized.includes('crie uma tarefa')) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      const dueAt = user.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/)?.[0]
      if (!eventId || !dueAt) {
        const message: AgentProviderMessage = { role: 'assistant', content: 'Preciso do evento e do prazo para criar a tarefa.' }
        return { message, toolCalls: [] }
      }
      return toolResponse('create_task', { eventId, title: 'Confirmar buffet', dueAt })
    }
    if (normalized.includes('mude o horario') || normalized.includes('mudar o horario')) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      const match = normalized.match(/(?:para|pras?|as)\s+(\d{1,2})(?::(\d{2}))?h?/)
      if (eventId && match) return toolResponse('propose_event_time_change', { eventId, time: `${String(Number(match[1])).padStart(2,'0')}:${match[2] ?? '00'}` })
    }
    if (/^(sim|aprova|pode aplicar)$/.test(normalized)) {
      const proposalId = firstPendingProposalId(input.messages)
      if (proposalId) return toolResponse('approve_change_proposal', { proposalId })
    }
    if (/^(nao|rejeita|cancela)$/.test(normalized)) {
      const proposalId = firstPendingProposalId(input.messages)
      if (proposalId) return toolResponse('reject_change_proposal', { proposalId })
    }
    if (/recalcul|aplique os ajustes|aplica os ajustes/.test(normalized) && !/risco/.test(normalized)) {
      const proposalId = firstOpenDependencyProposalId(input.messages)
      if (proposalId) return toolResponse('apply_dependency_suggestions', { proposalId })
    }
    if (/reaval.*risco|recalcul.*risco|avalie os riscos/.test(normalized)) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      if (eventId) return toolResponse('evaluate_event_risks', { eventId })
    }
    if (/\b(qual|que)\b.*\b(horario|hora)\b.*\b(brief|resumo)\b|\b(brief|resumo)\b.*\b(qual|que)\b.*\b(horario|hora)\b|\b(configuracao|configuracoes)\b.*\b(brief|resumo)\b/.test(normalized)) return toolResponse('get_daily_brief_settings', {})
    if (/configur|horario|hora|ativ|desativ|todo dia|todos os dias|diario|diariamente/.test(normalized) && /brief|resumo/.test(normalized)) {
      const args:Record<string,unknown>={}
      if(/desativ|deslig|desabilit/.test(normalized))args.enabled=false
      else if(/\b(ativ|habilit|ligue|mande|envie|quero receber)\b/.test(normalized)||/\b(todo dia|todos os dias|diariamente)\b/.test(normalized))args.enabled=true
      const localTime=extractDeterministicBriefTime(normalized)
      if(localTime)args.localTime=localTime
      const phone=user.match(/\+?\d[\d ()-]{8,20}\d/)?.[0]
      if(phone)args.recipient=phone
      return toolResponse('configure_daily_brief',args)
    }
    if (/gere|gerar|refaca|recrie|atualize/.test(normalized) && /brief|resumo/.test(normalized)) return toolResponse('generate_daily_brief', {})
    if (/historico/.test(normalized) && /brief|resumo/.test(normalized)) return toolResponse('get_brief_history', { limit: 10 })
    if (/brief|prioridades.*hoje|o que.*hoje|resumo.*hoje/.test(normalized)) return toolResponse('get_daily_brief', {})
    if (healthTerm && (/qual.*evento.*(?:sa(?:u|\uFFFD)de|health)|health.*workspace|sa(?:u|\uFFFD)de.*eventos|eventos.*sa(?:u|\uFFFD)de/.test(normalized))) return toolResponse('get_workspace_health', { limit: 10 })
    if (healthTerm && /reaval|recalcul|atualiz/.test(normalized)) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      if (eventId) return toolResponse('evaluate_event_health', { eventId })
    }
    if (healthTerm) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      if (eventId) return toolResponse('get_event_health', { eventId })
    }
    if (/qual.*evento.*(atencao|risco)|riscos.*workspace|eventos.*risco/.test(normalized)) return toolResponse('get_workspace_risks', { limit: 10 })
    if (/risco|preocup|urgente/.test(normalized)) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      if (eventId) return toolResponse('get_event_risks', { eventId, status: 'open', limit: 20 })
    }
    return toolResponse('get_workspace_overview', {})
  }
}

function extractDeterministicBriefTime(normalized: string): string | null {
  const patterns = [
    /\b([01]?\d|2[0-3])\s*h\s*([0-5]\d)\b/,
    /\b([01]?\d|2[0-3])\s*:\s*([0-5]\d)\b/,
    /\b([01]?\d|2[0-3])\s*h\b/,
    /\b(?:as|para|pras?|horario(?:\s+para)?)\s+([01]?\d|2[0-3])\b/,
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (!match) continue
    return `${String(Number(match[1])).padStart(2, '0')}:${match[2] ?? '00'}`
  }
  return null
}

function toolResponse(name: string, args: Record<string, unknown>): AgentProviderResponse {
  const call: AgentToolCall = { name, arguments: args }
  return { message: { role: 'assistant', content: '', toolCalls: [call] }, toolCalls: [call] }
}
function currentEventId(messages: AgentProviderMessage[]): string | null {
  const context = messages.find((message) => message.role === 'system' && message.content.includes('EVENTO ATUAL DA CONVERSA'))?.content ?? ''
  const section = context.split('EVENTO ATUAL DA CONVERSA')[1] ?? ''
  return section.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null
}
function firstPendingProposalId(messages: AgentProviderMessage[]): string | null {
  const context = messages.find((message) => message.role === 'system' && message.content.includes('PROPOSTAS DE MUDANÇA PENDENTES'))?.content ?? ''
  const section = context.split('PROPOSTAS DE MUDANÇA PENDENTES')[1] ?? ''
  return section.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null
}
function firstEventId(messages: AgentProviderMessage[]): string | null {
  const context = messages.find((message) => message.role === 'system' && message.content.includes('CATÁLOGO DE EVENTOS'))?.content ?? ''
  return context.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null
}

function firstOpenDependencyProposalId(messages: AgentProviderMessage[]): string | null { const context=messages.find((message)=>message.role==='system'&&message.content.includes('DEPENDÊNCIAS ABERTAS'))?.content??''; const section=context.split('DEPENDÊNCIAS ABERTAS')[1]??''; const match=section.match(/\"proposalId\":\"([0-9a-f-]{36})\"/i); return match?.[1]??null }
