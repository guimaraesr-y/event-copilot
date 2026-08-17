import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

interface Options {
  baseUrl: string
  organizationId: string
  sender: string
  eventId: string | null
}

const options = parseArgs(process.argv.slice(2))
const rl = createInterface({ input, output })
let sequence = 0

console.log('Event Command Center — Operational Agent')
console.log(`API    : ${options.baseUrl}`)
console.log(`Tenant : ${options.organizationId}`)
console.log(`Sender : ${options.sender}`)
console.log(`Event  : ${options.eventId ?? 'conversation context / agent resolution'}`)
console.log('Commands: /event <uuid>, /event clear, /history, /quit')
console.log('')

try {
  while (true) {
    const line = (await rl.question('Você > ')).trim()
    if (!line) continue
    if (line === '/quit' || line === '/exit') break
    if (line === '/history') {
      await showHistory(options)
      continue
    }
    if (line.startsWith('/event ')) {
      const value = line.slice('/event '.length).trim()
      options.eventId = value === 'clear' ? null : requireUuid(value, 'event UUID')
      console.log(`Contexto explícito para próxima mensagem: ${options.eventId ?? 'desativado'}`)
      continue
    }

    sequence += 1
    const idempotencyKey = `cli:${options.sender}:${Date.now()}:${sequence}`
    const response = await fetch(`${options.baseUrl}/api/v1/agent/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-organization-id': options.organizationId,
      },
      body: JSON.stringify({
        sender: options.sender,
        text: line,
        idempotencyKey,
        ...(options.eventId ? { eventId: options.eventId } : {}),
      }),
    })
    const body = await response.text()
    let payload: any
    try { payload = JSON.parse(body) } catch { payload = null }
    if (!response.ok) {
      console.error(`ECC ! HTTP ${response.status}: ${payload?.error?.message ?? body}`)
      continue
    }
    console.log(`ECC > ${payload?.data?.reply ?? body}`)
    const turn = payload?.data?.turn
    if (turn) console.log(`      [${turn.provider}/${turn.model} · modelCalls=${turn.modelCalls} · tools=${turn.toolTrace?.length ?? 0}]`)
  }
} finally {
  rl.close()
}

async function showHistory(options: Options) {
  const url = new URL(`${options.baseUrl}/api/v1/agent/history`)
  url.searchParams.set('sender', options.sender)
  url.searchParams.set('limit', '10')
  const response = await fetch(url, { headers: { 'x-organization-id': options.organizationId } })
  const body = await response.text()
  let payload: any
  try { payload = JSON.parse(body) } catch { payload = null }
  if (!response.ok) {
    console.error(`ECC ! HTTP ${response.status}: ${payload?.error?.message ?? body}`)
    return
  }
  for (const turn of payload?.data ?? []) {
    console.log(`- Você: ${turn.userText}`)
    console.log(`  ECC : ${turn.assistantText ?? '(sem resposta)'}`)
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string,string>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const value = args[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    values.set(arg, value)
    i += 1
  }
  const organizationId = values.get('--organization') ?? process.env.TENANT_ORGANIZATION_ID ?? ''
  if (!organizationId) throw new Error('Provide --organization <uuid> or TENANT_ORGANIZATION_ID')
  return {
    baseUrl: (values.get('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    organizationId: requireUuid(organizationId, 'organization UUID'),
    sender: values.get('--sender') ?? process.env.AGENT_SENDER ?? 'planner-local',
    eventId: values.has('--event') ? requireUuid(values.get('--event')!, 'event UUID') : null,
  }
}

function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}
