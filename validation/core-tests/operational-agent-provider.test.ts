import { OllamaOperationalAgentProvider } from '../../packages/event-engine/src/operational-agent-provider.ts'
import type { AgentToolDefinition } from '../../packages/event-engine/src/operational-agent-provider.ts'

function assert(ok: unknown, msg: string): asserts ok { if (!ok) throw new Error(`Assertion failed: ${msg}`) }

const tools: AgentToolDefinition[] = [
  {
    name: 'get_workspace_overview',
    description: 'Get overview',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'create_task',
    description: 'Create task',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { eventId: { type: 'string' }, title: { type: 'string' }, dueAt: { type: 'string' } },
      required: ['eventId','title','dueAt'],
    },
  },
]

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

{
  let body: any
  const provider = new OllamaOperationalAgentProvider({
    model: 'phi3:mini', toolMode: 'prompt', baseUrl: 'http://ollama.test',
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ message: { content: JSON.stringify({ type: 'tool', toolName: 'get_workspace_overview', arguments: {}, answer: null }) } })
    }) as typeof fetch,
  })
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Como estão meus eventos?' }], tools })
  assert(result.toolCalls.length === 1 && result.toolCalls[0]?.name === 'get_workspace_overview', 'prompt mode parses tool action')
  assert(body.model === 'phi3:mini' && body.stream === false && body.think === false, 'prompt mode sends deterministic Ollama chat request')
  assert(body.format?.properties?.type?.enum?.includes('tool'), 'prompt mode constrains action with JSON schema')
  assert(JSON.stringify(body.messages).includes('get_workspace_overview'), 'prompt mode injects available tool catalog')
}

{
  const provider = new OllamaOperationalAgentProvider({
    toolMode: 'prompt',
    fetchImpl: (async () => jsonResponse({ message: { content: JSON.stringify({ type: 'final', toolName: null, arguments: {}, answer: 'Você tem dois eventos ativos.' }) } })) as typeof fetch,
  })
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Resuma.' }], tools })
  assert(result.toolCalls.length === 0 && result.message.content === 'Você tem dois eventos ativos.', 'prompt mode parses final answer')
}

{
  let body: any
  const provider = new OllamaOperationalAgentProvider({
    toolMode: 'native', model: 'qwen3:4b',
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ message: { content: '', tool_calls: [{ function: { name: 'create_task', arguments: { eventId: 'event-1', title: 'Confirmar buffet', dueAt: '2026-10-01T10:00:00-03:00' } } }] } })
    }) as typeof fetch,
  })
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Crie a tarefa.' }], tools })
  assert(result.toolCalls[0]?.name === 'create_task', 'native mode parses Ollama tool_calls')
  assert(Array.isArray(body.tools) && body.tools[0]?.type === 'function', 'native mode sends function tool definitions')
}

{
  const provider = new OllamaOperationalAgentProvider({
    toolMode: 'prompt',
    fetchImpl: (async () => jsonResponse({ message: { content: JSON.stringify({ type: 'tool', toolName: 'drop_database', arguments: {}, answer: null }) } })) as typeof fetch,
  })
  let rejected = false
  try { await provider.complete({ messages: [{ role: 'user', content: 'Faça algo.' }], tools }) } catch (error) { rejected = String(error).includes('unknown tool') }
  assert(rejected, 'prompt mode rejects tools outside the server-owned allowlist')
}

console.log('OperationalAgentProvider: 4/4 behavioral scenarios passed')
