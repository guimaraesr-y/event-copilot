import {
  DeterministicOperationalAgentProvider,
  OllamaOperationalAgentProvider,
  OpenRouterOperationalAgentProvider,
  type OllamaAgentToolMode,
  type OpenRouterAgentToolMode,
  type OperationalAgentProvider,
} from '@ecc/event-engine'

export function createOperationalAgentProvider(): OperationalAgentProvider {
  const provider = (process.env.OPERATIONAL_AGENT_PROVIDER ?? 'ollama').trim().toLowerCase()
  if (provider === 'deterministic') return new DeterministicOperationalAgentProvider()

  if (provider === 'openrouter') {
    const mode = (process.env.OPENROUTER_AGENT_TOOL_MODE ?? 'native').trim().toLowerCase()
    if (mode !== 'prompt' && mode !== 'native') throw new Error(`Unsupported OPENROUTER_AGENT_TOOL_MODE: ${mode}. Expected prompt or native.`)
    const dataCollection = (process.env.OPENROUTER_DATA_COLLECTION ?? 'allow').trim().toLowerCase()
    if (dataCollection !== 'allow' && dataCollection !== 'deny') throw new Error(`Unsupported OPENROUTER_DATA_COLLECTION: ${dataCollection}. Expected allow or deny.`)
    return new OpenRouterOperationalAgentProvider({
      apiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
      model: process.env.OPENROUTER_AGENT_MODEL?.trim() || 'openrouter/auto',
      baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
      timeoutMs: positiveInt(process.env.OPENROUTER_AGENT_TIMEOUT_MS, 60_000),
      toolMode: mode as OpenRouterAgentToolMode,
      httpReferer: process.env.OPENROUTER_HTTP_REFERER?.trim() || undefined,
      appTitle: process.env.OPENROUTER_APP_TITLE?.trim() || undefined,
      requireParameters: booleanEnv(process.env.OPENROUTER_REQUIRE_PARAMETERS, true),
      dataCollection,
    })
  }

  if (provider !== 'ollama') {
    throw new Error(`Unsupported OPERATIONAL_AGENT_PROVIDER: ${provider}. Supported now: ollama, openrouter, deterministic. OpenAI and Gemini adapters remain future integrations.`)
  }
  const mode = (process.env.OLLAMA_AGENT_TOOL_MODE ?? 'prompt').trim().toLowerCase()
  if (mode !== 'prompt' && mode !== 'native') throw new Error(`Unsupported OLLAMA_AGENT_TOOL_MODE: ${mode}. Expected prompt or native.`)
  return new OllamaOperationalAgentProvider({
    model: process.env.OLLAMA_AGENT_MODEL?.trim() || process.env.OLLAMA_COMMAND_MODEL?.trim() || 'qwen3:4b',
    baseUrl: process.env.OLLAMA_BASE_URL?.trim() || 'http://ollama:11434',
    timeoutMs: positiveInt(process.env.OLLAMA_AGENT_TIMEOUT_MS, 120_000),
    keepAlive: process.env.OLLAMA_KEEP_ALIVE?.trim() || '10m',
    toolMode: mode as OllamaAgentToolMode,
  })
}

export function operationalAgentLimits() {
  return {
    maxModelCalls: positiveInt(process.env.OPERATIONAL_AGENT_MAX_MODEL_CALLS, 6),
    maxToolCalls: positiveInt(process.env.OPERATIONAL_AGENT_MAX_TOOL_CALLS, 8),
    historyTurns: nonNegativeInt(process.env.OPERATIONAL_AGENT_HISTORY_TURNS, 6),
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}
function booleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (['1','true','yes','on'].includes(value)) return true
  if (['0','false','no','off'].includes(value)) return false
  return fallback
}
