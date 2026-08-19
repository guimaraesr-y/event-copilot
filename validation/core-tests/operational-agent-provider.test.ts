import { DeterministicOperationalAgentProvider, OllamaOperationalAgentProvider, OpenRouterOperationalAgentProvider } from '../../packages/event-engine/src/operational-agent-provider.ts'
import type { AgentProviderMessage, AgentToolDefinition } from '../../packages/event-engine/src/operational-agent-provider.ts'

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

console.log('OperationalAgentProvider Ollama: 4/4 behavioral scenarios passed')


{
  let body: any
  let headers: Record<string, string> = {}
  const provider = new OpenRouterOperationalAgentProvider({
    apiKey: 'sk-or-test', model: 'openrouter/auto', toolMode: 'native',
    httpReferer: 'https://ecc.example.test', appTitle: 'ECC Test',
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'))
      headers = Object.fromEntries(new Headers(init?.headers).entries())
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'get_workspace_overview', arguments: '{}' } }] } }] })
    }) as typeof fetch,
  })
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Como estão meus eventos?' }], tools, sessionId: 'turn-session-1' })
  assert(result.toolCalls[0]?.id === 'call_123' && result.toolCalls[0]?.name === 'get_workspace_overview', 'OpenRouter native parses standardized tool call')
  assert(body.model === 'openrouter/auto' && body.tool_choice === 'auto', 'OpenRouter native sends chat completion with model and tools')
  assert(body.session_id === 'turn-session-1', 'OpenRouter uses agent turn id as sticky routing session')
  assert(body.provider?.require_parameters === true, 'OpenRouter requires provider parameter support by default')
  assert(headers['authorization'] === 'Bearer sk-or-test', 'OpenRouter sends bearer API key')
  assert(headers['http-referer'] === 'https://ecc.example.test' && headers['x-openrouter-title'] === 'ECC Test', 'OpenRouter sends optional attribution headers')
}

{
  let body: any
  const provider = new OpenRouterOperationalAgentProvider({
    apiKey: 'sk-or-test', model: 'provider/model', toolMode: 'native',
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Você tem dois eventos.' } }] })
    }) as typeof fetch,
  })
  const result = await provider.complete({
    messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc', name: 'get_workspace_overview', arguments: {} }] },
      { role: 'tool', toolName: 'get_workspace_overview', toolCallId: 'call_abc', content: '{"count":2}' },
    ], tools,
  })
  assert(result.message.content === 'Você tem dois eventos.', 'OpenRouter native accepts final response after tool result')
  assert(body.messages[0]?.tool_calls?.[0]?.id === 'call_abc', 'OpenRouter preserves assistant tool call id')
  assert(body.messages[1]?.tool_call_id === 'call_abc', 'OpenRouter maps tool result to tool_call_id')
}

{
  let body: any
  const provider = new OpenRouterOperationalAgentProvider({
    apiKey: 'sk-or-test', model: 'provider/structured-model', toolMode: 'prompt', dataCollection: 'deny',
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ type: 'tool', toolName: 'get_workspace_overview', arguments: {}, answer: null }) } }] })
    }) as typeof fetch,
  })
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Resuma meus eventos.' }], tools })
  assert(result.toolCalls[0]?.name === 'get_workspace_overview', 'OpenRouter prompt mode parses structured tool action')
  assert(body.response_format?.type === 'json_schema' && body.response_format?.json_schema?.strict === true, 'OpenRouter prompt mode requests strict JSON schema output')
  assert(body.provider?.data_collection === 'deny', 'OpenRouter forwards data collection preference')
}

{
  const provider = new OpenRouterOperationalAgentProvider({ apiKey: '', toolMode: 'native' })
  let rejected = false
  try { await provider.complete({ messages: [{ role: 'user', content: 'oi' }], tools }) } catch (error) { rejected = String(error).includes('OPENROUTER_API_KEY') }
  assert(rejected, 'OpenRouter rejects missing API key before network access')
}

console.log('OperationalAgentProvider OpenRouter: 4/4 behavioral scenarios passed')


{
  const provider = new DeterministicOperationalAgentProvider()
  const eventId = '11111111-1111-4111-8111-111111111111'
  const healthTools: AgentToolDefinition[] = [
    ...tools,
    {
      name: 'get_event_health',
      description: 'Get event Health Score',
      parameters: { type: 'object', additionalProperties: false, properties: { eventId: { type: 'string' } }, required: ['eventId'] },
    },
  ]
  const system: AgentProviderMessage = { role: 'system', content: `EVENTO ATUAL DA CONVERSA\n${eventId}` }
  const variants = [
    'Qual a saude deste evento?',
    'Qual a saúde deste evento?',
    'Qual a sa\uFFFDde deste evento?',
  ]
  for (const content of variants) {
    const result = await provider.complete({ messages: [system, { role: 'user', content }], tools: healthTools })
    assert(result.toolCalls[0]?.name === 'get_event_health', `deterministic health routing tolerates: ${content}`)
    assert(result.toolCalls[0]?.arguments.eventId === eventId, 'deterministic health routing preserves current event')
  }
}

console.log('OperationalAgentProvider deterministic health routing: 3/3 encoding scenarios passed')
