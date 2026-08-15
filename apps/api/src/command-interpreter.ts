import { AICommandInterpreter, RuleBasedCommandInterpreter } from '@ecc/event-engine'
import type { CommandInterpreter } from '@ecc/domain'

export function createCommandInterpreter(): CommandInterpreter {
  const mode = (process.env.COMMAND_INTERPRETER ?? 'rule_based').trim().toLowerCase()
  if (mode === 'rule_based') return new RuleBasedCommandInterpreter()
  if (mode === 'ai') {
    const apiKey = process.env.OPENAI_API_KEY?.trim() ?? ''
    const timeout = Number.parseInt(process.env.OPENAI_COMMAND_TIMEOUT_MS ?? '20000', 10)
    return new AICommandInterpreter({
      apiKey,
      model: process.env.OPENAI_COMMAND_MODEL?.trim() || 'gpt-5.6',
      baseUrl: process.env.OPENAI_API_BASE_URL?.trim() || 'https://api.openai.com/v1',
      timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 20_000,
    })
  }
  throw new Error(`Unsupported COMMAND_INTERPRETER: ${mode}. Expected rule_based or ai.`)
}
