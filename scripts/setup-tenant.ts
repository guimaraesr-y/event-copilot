#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type JsonRecord = Record<string, unknown>

type State = {
  organizationId?: string
  templateId?: string
  eventId?: string
  vendorId?: string
  eventVendorId?: string
  updatedAt?: string
}

type Args = {
  config?: string
  state?: string
  sendConfirmation: boolean
  dryRun: boolean
  forceNewEvent: boolean
  json: boolean
}

const args = parseArgs(process.argv.slice(2))
const fileEnv = args.config ? readEnvFile(args.config) : {}
const env = { ...fileEnv, ...process.env } as Record<string, string | undefined>

const baseUrl = stripTrailingSlash(env.BASE_URL ?? 'http://localhost:8080')
const tenantName = required(env, 'TENANT_NAME')
const timezone = env.TENANT_TIMEZONE ?? 'America/Sao_Paulo'
const eventName = required(env, 'EVENT_NAME')
const eventType = (env.EVENT_TYPE ?? 'wedding') as 'wedding' | 'birthday' | 'corporate' | 'other'
const eventStartAt = required(env, 'EVENT_START_AT')
const eventEndAt = emptyToUndefined(env.EVENT_END_AT)
const guestCount = intEnv(env.EVENT_GUEST_COUNT, 0)
const venueName = emptyToUndefined(env.EVENT_VENUE_NAME)
const venueAddress = emptyToUndefined(env.EVENT_VENUE_ADDRESS)

const templateName = env.TEMPLATE_NAME ?? defaultTemplateName(eventType)
const setupDefaultPlan = boolEnv(env.SETUP_DEFAULT_TEMPLATE_PLAN, true)

const vendorName = required(env, 'VENDOR_NAME')
const vendorCategory = env.VENDOR_CATEGORY ?? 'photo'
const vendorContactName = emptyToUndefined(env.VENDOR_CONTACT_NAME)
const vendorPhone = required(env, 'VENDOR_PHONE')
const vendorEmail = emptyToUndefined(env.VENDOR_EMAIL)
const vendorNotes = emptyToUndefined(env.VENDOR_NOTES)
const contractStatus = env.VENDOR_CONTRACT_STATUS ?? 'signed'
const paymentStatus = env.VENDOR_PAYMENT_STATUS ?? 'not_applicable'
const confirmationDeadlineAt = emptyToUndefined(env.CONFIRMATION_DEADLINE_AT)

const slug = slugify(tenantName)
const statePath = resolve(args.state ?? env.TENANT_STATE_FILE ?? `.ecc/tenants/${slug}.json`)
const state = readState(statePath)
let runtimeState: State = { ...state }

await assertReady()

const organizationId = await ensureOrganization()
remember({ organizationId })
const template = await ensureTemplate(organizationId)
remember({ templateId: template.id })
if (setupDefaultPlan) await ensureTemplatePlan(organizationId, template.id)
const event = await ensureEvent(organizationId, template.id)
remember({ eventId: event.id })
const vendor = await ensureVendor(organizationId)
remember({ vendorId: vendor.id })
const assignment = await ensureAssignment(organizationId, event.id, vendor.id)
remember({ eventVendorId: assignment.id })

let confirmation: JsonRecord | null = null
if (args.sendConfirmation) {
  confirmation = await ensureConfirmationRequested(organizationId, event.id, assignment)
}

remember({
  organizationId,
  templateId: template.id,
  eventId: event.id,
  vendorId: vendor.id,
  eventVendorId: assignment.id,
})

const result = {
  baseUrl,
  stateFile: statePath,
  dryRun: args.dryRun,
  organization: { id: organizationId, name: tenantName, timezone },
  template: { id: template.id, name: template.name },
  event: { id: event.id, name: event.name, startAt: event.startAt },
  vendor: { id: vendor.id, name: vendor.name, phone: vendor.phone },
  assignment: { id: assignment.id, confirmationStatus: assignment.confirmationStatus },
  confirmation: confirmation
    ? { requested: true, confirmationStatus: confirmation.confirmationStatus }
    : { requested: false },
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('\nECC tenant setup complete')
  console.log(`  Organization : ${tenantName} (${organizationId})`)
  console.log(`  Template     : ${template.name} (${template.id})`)
  console.log(`  Event        : ${event.name} (${event.id})`)
  console.log(`  Vendor       : ${vendor.name} / ${vendor.phone} (${vendor.id})`)
  console.log(`  Assignment   : ${assignment.id} [${assignment.confirmationStatus}]`)
  console.log(`  Confirmation : ${args.sendConfirmation ? 'requested/reused' : 'not requested'}`)
  console.log(`  State        : ${statePath}${args.dryRun ? ' (not written: dry-run)' : ''}`)
  if (!args.sendConfirmation) {
    console.log('\nTo send the vendor confirmation after reviewing the setup:')
    console.log(`  bun scripts/setup-tenant.ts${args.config ? ` --config ${shellQuote(args.config)}` : ''} --send-confirmation`)
  }
}

async function assertReady(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/health/ready`).catch((error) => {
    throw new Error(`ECC API is unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!response.ok) throw new Error(`ECC API is not ready: HTTP ${response.status} ${await response.text()}`)
}

async function ensureOrganization(): Promise<string> {
  const configured = emptyToUndefined(env.TENANT_ORGANIZATION_ID)
  const known = configured ?? state.organizationId

  if (known) {
    const probe = await request('/api/v1/event-templates', { organizationId: known, allow: [200, 404] })
    if (probe.status === 200) {
      log(`organization: reuse ${known}`)
      return known
    }
    throw new Error(
      `Configured organization ${known} was not found. Remove/update ${statePath} or TENANT_ORGANIZATION_ID before retrying.`,
    )
  }

  if (args.dryRun) {
    throw new Error('Dry-run cannot create the first organization because no TENANT_ORGANIZATION_ID/state exists yet.')
  }

  const response = await request('/api/v1/organizations', {
    method: 'POST',
    body: { name: tenantName, timezone },
    expect: 201,
  })
  const id = stringField(dataOf(response.body), 'id')
  log(`organization: created ${id}`)
  return id
}

async function ensureTemplate(organizationId: string): Promise<any> {
  const list = dataArray(await apiJson('/api/v1/event-templates', organizationId))
  const matches = list.filter((item) => item.name === templateName && item.eventType === eventType)
  if (matches.length > 1) throw new Error(`More than one template matches ${templateName}/${eventType}; set TEMPLATE_NAME uniquely.`)
  if (matches.length === 1) {
    log(`template: reuse ${matches[0].id}`)
    return matches[0]
  }

  if (args.dryRun) return { id: '<would-create-template>', name: templateName, eventType }
  const created = dataOf(
    (await request('/api/v1/event-templates', {
      method: 'POST', organizationId, expect: 201,
      body: { name: templateName, eventType, description: `Bootstrap template for ${tenantName}` },
    })).body,
  )
  log(`template: created ${created.id}`)
  return created
}

async function ensureTemplatePlan(organizationId: string, templateId: string): Promise<void> {
  if (args.dryRun || templateId.startsWith('<')) return
  const snapshot = dataOf(await apiJson(`/api/v1/event-templates/${templateId}`, organizationId))
  const existingTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  const existingMilestones = Array.isArray(snapshot.milestones) ? snapshot.milestones : []

  for (const task of defaultTasks(eventType)) {
    if (existingTasks.some((item: any) => item.title === task.title)) continue
    await request(`/api/v1/event-templates/${templateId}/tasks`, {
      method: 'POST', organizationId, body: task, expect: 201,
    })
    log(`template task: created ${task.title}`)
  }

  for (const milestone of defaultMilestones(eventType)) {
    if (existingMilestones.some((item: any) => item.name === milestone.name)) continue
    await request(`/api/v1/event-templates/${templateId}/milestones`, {
      method: 'POST', organizationId, body: milestone, expect: 201,
    })
    log(`template milestone: created ${milestone.name}`)
  }
}

async function ensureEvent(organizationId: string, templateId: string): Promise<any> {
  const list = dataArray(await apiJson('/api/v1/events', organizationId))
  const exact = list.filter((item) => item.name === eventName && item.type === eventType)

  if (!args.forceNewEvent && state.eventId) {
    const fromState = list.find((item) => item.id === state.eventId)
    if (fromState) {
      log(`event: reuse state ${fromState.id}`)
      return fromState
    }
  }

  if (!args.forceNewEvent && exact.length === 1) {
    log(`event: reuse ${exact[0].id}`)
    return exact[0]
  }
  if (!args.forceNewEvent && exact.length > 1) {
    throw new Error(`Multiple events named ${eventName} exist. Use the saved state or --force-new-event explicitly.`)
  }

  if (args.dryRun) return { id: '<would-create-event>', name: eventName, startAt: eventStartAt }
  const created = dataOf(
    (await request('/api/v1/events', {
      method: 'POST', organizationId, expect: 201,
      body: {
        name: eventName,
        type: eventType,
        templateId,
        startAt: eventStartAt,
        ...(eventEndAt ? { endAt: eventEndAt } : {}),
        ...(venueName ? { venueName } : {}),
        ...(venueAddress ? { venueAddress } : {}),
        guestCount,
      },
    })).body,
  )
  log(`event: created ${created.id}`)
  return created
}

async function ensureVendor(organizationId: string): Promise<any> {
  const list = dataArray(await apiJson('/api/v1/vendors', organizationId))
  const normalizedPhone = normalizePhone(vendorPhone)
  const matches = list.filter((item) => item.name === vendorName && normalizePhone(String(item.phone ?? '')) === normalizedPhone)
  if (matches.length > 1) throw new Error(`More than one vendor matches name=${vendorName} phone=${vendorPhone}.`)
  if (matches.length === 1) {
    log(`vendor: reuse ${matches[0].id}`)
    return matches[0]
  }

  if (args.dryRun) return { id: '<would-create-vendor>', name: vendorName, phone: vendorPhone }
  const created = dataOf(
    (await request('/api/v1/vendors', {
      method: 'POST', organizationId, expect: 201,
      body: {
        name: vendorName,
        category: vendorCategory,
        ...(vendorContactName ? { contactName: vendorContactName } : {}),
        phone: vendorPhone,
        ...(vendorEmail ? { email: vendorEmail } : {}),
        ...(vendorNotes ? { notes: vendorNotes } : {}),
      },
    })).body,
  )
  log(`vendor: created ${created.id}`)
  return created
}

async function ensureAssignment(organizationId: string, eventId: string, vendorId: string): Promise<any> {
  if (args.dryRun || eventId.startsWith('<') || vendorId.startsWith('<')) {
    return { id: '<would-create-assignment>', confirmationStatus: 'pending' }
  }

  const list = dataArray(await apiJson(`/api/v1/events/${eventId}/vendors`, organizationId))
  const existing = list.find((item) => item.vendorId === vendorId)
  if (existing) {
    log(`assignment: reuse ${existing.id}`)
    return existing
  }

  const created = dataOf(
    (await request(`/api/v1/events/${eventId}/vendors`, {
      method: 'POST', organizationId, expect: 201,
      body: {
        vendorId,
        contractStatus,
        paymentStatus,
        ...(vendorContactName ? { contactName: vendorContactName } : {}),
        phone: vendorPhone,
        ...(vendorEmail ? { email: vendorEmail } : {}),
      },
    })).body,
  )
  log(`assignment: created ${created.id}`)
  return created
}

async function ensureConfirmationRequested(organizationId: string, eventId: string, assignment: any): Promise<any> {
  if (args.dryRun) {
    log('confirmation: would request')
    return { confirmationStatus: 'requested' }
  }
  if (assignment.confirmationStatus === 'requested') {
    log('confirmation: already requested')
    return assignment
  }
  if (assignment.confirmationStatus === 'confirmed' || assignment.confirmationStatus === 'declined') {
    throw new Error(`Vendor assignment is already ${assignment.confirmationStatus}; refusing to send a new confirmation.`)
  }
  const updated = dataOf(
    (await request(`/api/v1/events/${eventId}/vendors/${assignment.id}/confirmation-request`, {
      method: 'POST', organizationId, expect: 200,
      body: confirmationDeadlineAt ? { deadlineAt: confirmationDeadlineAt } : {},
    })).body,
  )
  log(`confirmation: requested (${updated.confirmationStatus})`)
  return updated
}

async function apiJson(path: string, organizationId?: string): Promise<any> {
  return (await request(path, { organizationId, expect: 200 })).body
}

async function request(
  path: string,
  options: {
    method?: string
    organizationId?: string
    body?: unknown
    expect?: number
    allow?: number[]
  } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.organizationId) headers['x-organization-id'] = options.organizationId
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  if (args.dryRun && (options.method ?? 'GET') !== 'GET') {
    log(`[dry-run] ${options.method ?? 'GET'} ${path}`)
    return { status: options.expect ?? 200, body: { data: {} } }
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  let body: any = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }

  const allowed = options.allow ?? (options.expect !== undefined ? [options.expect] : [200])
  if (!allowed.includes(response.status)) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed: HTTP ${response.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }
  return { status: response.status, body }
}

function defaultTasks(type: string): Array<JsonRecord> {
  if (type !== 'wedding') return [
    { title: 'Confirmar fornecedores', offsetDays: -7, dueTime: '09:00', priority: 'high', type: 'confirmation', sortOrder: 10 },
    { title: 'Checklist final', offsetDays: -1, dueTime: '09:00', priority: 'critical', type: 'briefing', sortOrder: 20 },
  ]
  return [
    { title: 'Fechar RSVP', offsetDays: -30, dueTime: '09:00', priority: 'high', type: 'guest', sortOrder: 10 },
    { title: 'Confirmar fornecedores', offsetDays: -15, dueTime: '09:00', priority: 'high', type: 'confirmation', sortOrder: 20 },
    { title: 'Preparar briefing final', offsetDays: -7, dueTime: '09:00', priority: 'high', type: 'briefing', sortOrder: 30 },
    { title: 'Executar checklist final', offsetDays: -1, dueTime: '09:00', priority: 'critical', type: 'briefing', sortOrder: 40 },
  ]
}

function defaultMilestones(type: string): Array<JsonRecord> {
  if (type !== 'wedding') return [
    { name: 'Confirmação geral', offsetDays: -7, dueTime: '18:00', sortOrder: 10 },
  ]
  return [
    { name: 'Fechamento da lista de convidados', offsetDays: -30, dueTime: '18:00', sortOrder: 10 },
    { name: 'Confirmação geral de fornecedores', offsetDays: -7, dueTime: '18:00', sortOrder: 20 },
  ]
}

function defaultTemplateName(type: string): string {
  if (type === 'wedding') return 'Casamento Padrão'
  if (type === 'birthday') return 'Aniversário Padrão'
  if (type === 'corporate') return 'Evento Corporativo Padrão'
  return 'Evento Padrão'
}

function parseArgs(argv: string[]): Args {
  const result: Args = { sendConfirmation: false, dryRun: false, forceNewEvent: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') result.config = requiredArg(argv, ++index, '--config')
    else if (arg === '--state') result.state = requiredArg(argv, ++index, '--state')
    else if (arg === '--send-confirmation') result.sendConfirmation = true
    else if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--force-new-event') result.forceNewEvent = true
    else if (arg === '--json') result.json = true
    else if (arg === '--help' || arg === '-h') usage(0)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return result
}

function usage(code: number): never {
  console.log(`Usage: bun scripts/setup-tenant.ts [options]\n\nOptions:\n  --config <file>          Read tenant setup variables from a file\n  --state <file>           Override the state file path\n  --send-confirmation      Request vendor confirmation after setup\n  --dry-run                Show writes without performing them (requires existing organization)\n  --force-new-event        Create a new event even if an exact name/type match exists\n  --json                   Print the final result as JSON\n  -h, --help               Show this help\n`)
  process.exit(code)
}

function readEnvFile(path: string): Record<string, string> {
  const output: Record<string, string> = {}
  const content = readFileSync(resolve(path), 'utf8')
  for (const originalLine of content.split(/\r?\n/)) {
    const line = originalLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    output[key] = value
  }
  return output
}


function remember(patch: Partial<State>): void {
  runtimeState = { ...runtimeState, ...patch, updatedAt: new Date().toISOString() }
  if (!args.dryRun) writeState(statePath, runtimeState)
}

function readState(path: string): State {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) as State }
  catch (error) { throw new Error(`Cannot parse tenant state ${path}: ${error instanceof Error ? error.message : String(error)}`) }
}

function writeState(path: string, value: State): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function dataOf(body: any): any {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error(`Unexpected API response: ${JSON.stringify(body)}`)
  return body.data
}

function dataArray(body: any): any[] {
  const data = dataOf(body)
  if (!Array.isArray(data)) throw new Error(`Expected API data array: ${JSON.stringify(body)}`)
  return data
}

function stringField(object: any, key: string): string {
  const value = object?.[key]
  if (typeof value !== 'string' || !value) throw new Error(`Expected string field ${key}: ${JSON.stringify(object)}`)
  return value
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = emptyToUndefined(env[key])
  if (!value) throw new Error(`Missing required setup variable: ${key}`)
  return value
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function intEnv(value: string | undefined, fallback: number): number {
  if (!emptyToUndefined(value)) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, got ${value}`)
  return parsed
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (!emptyToUndefined(value)) return fallback
  if (/^(1|true|yes|on)$/i.test(value!)) return true
  if (/^(0|false|no|off)$/i.test(value!)) return false
  throw new Error(`Expected boolean, got ${value}`)
}

function normalizePhone(value: string): string { return value.replace(/\D/g, '') }
function stripTrailingSlash(value: string): string { return value.replace(/\/+$/, '') }
function slugify(value: string): string { return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tenant' }
function requiredArg(argv: string[], index: number, flag: string): string { const value = argv[index]; if (!value) throw new Error(`${flag} requires a value`); return value }
function log(message: string): void { if (!args.json) console.log(`[tenant-setup] ${message}`) }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }
