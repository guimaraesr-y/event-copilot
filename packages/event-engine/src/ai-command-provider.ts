import { CommandInterpreterError } from '@ecc/domain'

export type AICommandProviderKind = 'ollama' | 'openai'

export interface AICommandProviderRequest {
  system: string
  context: Record<string, unknown>
  schema: Record<string, unknown>
}

export interface AICommandProvider {
  readonly kind: AICommandProviderKind
  generate(request: AICommandProviderRequest): Promise<unknown>
}

interface BaseProviderOptions {
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface OllamaCommandProviderOptions extends BaseProviderOptions {
  keepAlive?: string
}

export class OllamaCommandProvider implements AICommandProvider {
  readonly kind = 'ollama' as const
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly keepAlive: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OllamaCommandProviderOptions = {}) {
    this.model = options.model?.trim() || 'qwen3:4b'
    this.baseUrl = (options.baseUrl?.trim() || 'http://ollama:11434').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.keepAlive = options.keepAlive?.trim() || '10m'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async generate(request: AICommandProviderRequest): Promise<unknown> {
    // Ollama recommends passing the JSON schema both as `format` and in the prompt
    // for the most reliable structured output.
    const schemaText = JSON.stringify(request.schema)
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        keep_alive: this.keepAlive,
        format: request.schema,
        options: { temperature: 0 },
        messages: [
          {
            role: 'system',
            content: `${request.system} Return only data matching this JSON Schema: ${schemaText}`,
          },
          { role: 'user', content: JSON.stringify(request.context) },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new CommandInterpreterError(`Ollama API returned ${response.status}: ${body.slice(0, 500)}`)
    }

    const payload = await response.json() as any
    const content = payload?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new CommandInterpreterError('Ollama response did not contain message.content')
    }

    try {
      return JSON.parse(content)
    } catch {
      throw new CommandInterpreterError('Ollama structured output was not valid JSON')
    }
  }
}

export interface OpenAICommandProviderOptions extends BaseProviderOptions {
  apiKey: string
}

export class OpenAICommandProvider implements AICommandProvider {
  readonly kind = 'openai' as const
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: OpenAICommandProviderOptions) {
    if (!options.apiKey.trim()) throw new CommandInterpreterError('OPENAI_API_KEY is required when AI_PROVIDER=openai')
    this.model = options.model?.trim() || 'gpt-5.6'
    this.baseUrl = (options.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async generate(request: AICommandProviderRequest): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions: request.system,
        input: JSON.stringify(request.context),
        text: {
          format: {
            type: 'json_schema',
            name: 'ecc_command_interpretation',
            strict: true,
            schema: request.schema,
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

    try {
      return JSON.parse(outputText)
    } catch {
      throw new CommandInterpreterError('OpenAI structured output was not valid JSON')
    }
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
