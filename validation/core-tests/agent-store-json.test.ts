import {
  normalizeAgentToolTrace,
  serializeAgentToolTrace,
} from '../../packages/database/src/repositories/agent-turn-json.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const entry = {
  index: 1,
  name: 'get_workspace_overview',
  arguments: {},
  result: { events: 2 },
}

{
  const serialized = serializeAgentToolTrace([])
  assert(serialized === '[]', 'empty trace is serialized as JSON array text, never as a PostgreSQL array')
}

{
  const serialized = serializeAgentToolTrace([entry])
  const parsed = JSON.parse(serialized)
  assert(Array.isArray(parsed) && parsed[0]?.name === 'get_workspace_overview', 'non-empty trace survives explicit JSON serialization')
}

{
  const normalized = normalizeAgentToolTrace([entry])
  assert(normalized.length === 1 && normalized[0]?.index === 1, 'already parsed JSONB array is preserved')
}

{
  const normalized = normalizeAgentToolTrace(JSON.stringify([entry]))
  assert(normalized.length === 1 && normalized[0]?.name === 'get_workspace_overview', 'JSON text is parsed defensively')
}

{
  const normalized = normalizeAgentToolTrace({})
  assert(normalized.length === 0, 'legacy malformed {} trace is normalized to []')
}

{
  const normalized = normalizeAgentToolTrace('{not-json')
  assert(normalized.length === 0, 'invalid legacy JSON cannot crash the agent')
}

console.log('AgentStore JSONB trace: 6/6 regression scenarios passed')
