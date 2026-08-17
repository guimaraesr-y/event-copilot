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
  }): Promise<AgentProviderResponse>
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

  async complete(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[] }): Promise<AgentProviderResponse> {
    return this.toolMode === 'native' ? this.completeNative(input) : this.completePrompt(input)
  }

  private async completeNative(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[] }): Promise<AgentProviderResponse> {
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

  private async completePrompt(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[] }): Promise<AgentProviderResponse> {
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
    if (action?.type === 'final') {
      const answer = typeof action.answer === 'string' ? action.answer.trim() : ''
      if (!answer) throw new OperationalAgentProviderError('Ollama prompt-agent final action did not contain an answer')
      const message: AgentProviderMessage = { role: 'assistant', content: answer }
      return { message, toolCalls: [] }
    }
    if (action?.type !== 'tool') throw new OperationalAgentProviderError('Ollama prompt-agent action type must be tool or final')
    const name = requireToolName(action.toolName)
    if (!input.tools.some((tool) => tool.name === name)) throw new OperationalAgentProviderError(`Ollama requested unknown tool: ${name}`)
    const toolCall: AgentToolCall = { name, arguments: objectValue(action.arguments) }
    return {
      message: { role: 'assistant', content: '', toolCalls: [toolCall] },
      toolCalls: [toolCall],
    }
  }
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

  async complete(input: { messages: AgentProviderMessage[]; tools: AgentToolDefinition[] }): Promise<AgentProviderResponse> {
    const last = input.messages[input.messages.length - 1]
    if (last?.role === 'tool') {
      const message: AgentProviderMessage = { role: 'assistant', content: `Operação concluída com ${last.toolName ?? 'ferramenta'}.` }
      return { message, toolCalls: [] }
    }
    const user = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
    const normalized = user.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    if (normalized.includes('crie uma tarefa')) {
      const eventId = currentEventId(input.messages) ?? firstEventId(input.messages)
      const dueAt = user.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/)?.[0]
      if (!eventId || !dueAt) {
        const message: AgentProviderMessage = { role: 'assistant', content: 'Preciso do evento e do prazo para criar a tarefa.' }
        return { message, toolCalls: [] }
      }
      return toolResponse('create_task', { eventId, title: 'Confirmar buffet', dueAt })
    }
    return toolResponse('get_workspace_overview', {})
  }
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
function firstEventId(messages: AgentProviderMessage[]): string | null {
  const context = messages.find((message) => message.role === 'system' && message.content.includes('CATÁLOGO DE EVENTOS'))?.content ?? ''
  return context.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null
}
