import {
  AICommandInterpreter,
  OllamaCommandProvider,
  OpenAICommandProvider,
  RuleBasedCommandInterpreter,
} from '@ecc/event-engine'
import type { CommandInterpreter } from '@ecc/domain'

export function createCommandInterpreter(): CommandInterpreter {
  const mode = (process.env.COMMAND_INTERPRETER ?? 'rule_based').trim().toLowerCase()
  if (mode === 'rule_based') return new RuleBasedCommandInterpreter()
  if (mode !== 'ai') {
    throw new Error(`Unsupported COMMAND_INTERPRETER: ${mode}. Expected rule_based or ai.`)
  }

  const provider = (process.env.AI_PROVIDER ?? 'ollama').trim().toLowerCase()
  if (provider === 'ollama') {
    return new AICommandInterpreter(new OllamaCommandProvider({
      model: process.env.OLLAMA_COMMAND_MODEL?.trim() || 'qwen3:4b',
      baseUrl: process.env.OLLAMA_BASE_URL?.trim() || 'http://ollama:11434',
      timeoutMs: positiveInt(process.env.OLLAMA_COMMAND_TIMEOUT_MS, 120_000),
      keepAlive: process.env.OLLAMA_KEEP_ALIVE?.trim() || '10m',
    }))
  }

  if (provider === 'openai') {
    return new AICommandInterpreter(new OpenAICommandProvider({
      apiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
      model: process.env.OPENAI_COMMAND_MODEL?.trim() || 'gpt-5.6',
      baseUrl: process.env.OPENAI_API_BASE_URL?.trim() || 'https://api.openai.com/v1',
      timeoutMs: positiveInt(process.env.OPENAI_COMMAND_TIMEOUT_MS, 20_000),
    }))
  }

  throw new Error(`Unsupported AI_PROVIDER: ${provider}. Expected ollama or openai. Gemini is reserved for a future provider adapter.`)
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}
