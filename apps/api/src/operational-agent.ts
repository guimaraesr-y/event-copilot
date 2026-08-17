import { DeterministicOperationalAgentProvider, OllamaOperationalAgentProvider, type OllamaAgentToolMode, type OperationalAgentProvider } from '@ecc/event-engine'

export function createOperationalAgentProvider(): OperationalAgentProvider {
  const provider = (process.env.OPERATIONAL_AGENT_PROVIDER ?? 'ollama').trim().toLowerCase()
  if (provider === 'deterministic') return new DeterministicOperationalAgentProvider()
  if (provider !== 'ollama') {
    throw new Error(`Unsupported OPERATIONAL_AGENT_PROVIDER: ${provider}. Ollama is implemented now; OpenAI and Gemini remain provider adapters for future integration.`)
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
