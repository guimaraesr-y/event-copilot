import { OperationalProjector } from '../../packages/event-engine/src/operational-projector.ts'
import type { OutboxMessage } from '@ecc/domain'

let passed = 0
function ok(condition: unknown, name: string) { if (!condition) throw new Error(`FAIL ${name}`); passed += 1; console.log(`OK ${name}`) }
const projector = new OperationalProjector()
function event(eventType: string, payload: Record<string, unknown> = {}): OutboxMessage {
  return { id: crypto.randomUUID(), organizationId: crypto.randomUUID(), eventType, aggregateType: 'event_vendor', aggregateId: crypto.randomUUID(),
    occurredAt: new Date('2026-08-14T12:00:00Z'), payload, attempts: 0, availableAt: new Date(), claimedAt: null, claimedBy: null, dispatchedAt: null, lastError: null }
}
const eventId = crypto.randomUUID()
let projection = projector.project(event('vendor.confirmed', { eventId, vendorName: 'Luz Foto', arrivalAt: '2026-10-17T17:30:00Z', teamSize: 3 }))
ok(projection.activity?.action === 'vendor.confirmed' && projection.activity.eventId === eventId && projection.inbox === null, 'vendor confirmed becomes activity')
projection = projector.project(event('vendor.declined', { eventId, vendorName: 'Luz Foto' }))
ok(projection.activity?.action === 'vendor.declined' && projection.inbox?.severity === 'critical', 'vendor decline becomes activity and critical inbox')
projection = projector.project(event('message.failed', { eventId, error: 'provider unavailable' }))
ok(projection.activity === null && projection.inbox?.type === 'message_failed', 'message failure becomes inbox')
projection = projector.project(event('message.review_required', { reason: 'Multiple pending vendor confirmations match sender' }))
ok(projection.inbox?.type === 'inbound_message_review', 'review required becomes inbox')
projection = projector.project(event('task.created', { eventId, title: 'Confirmar buffet', source: 'automation' }))
ok(projection.activity?.action === 'task.created' && projection.activity.actorType === 'automation', 'command task creation becomes activity')
projection = projector.project(event('event.note_added', { eventId, text: 'Acesso facilitado' }))
ok(projection.activity?.action === 'event.note_added' && projection.activity.description === 'Acesso facilitado', 'event note becomes activity')
projection = projector.project(event('change.proposed', { eventId, changeType: 'event_time', impacts: [{ severity: 'critical' }] }))
ok(projection.activity?.action === 'change.proposed' && projection.inbox?.type === 'change_proposal_approval' && projection.inbox.severity === 'critical', 'change proposal becomes activity and approval inbox')
projection = projector.project(event('change.applied', { eventId, changeType: 'event_time' }))
ok(projection.activity?.action === 'change.applied' && projection.resolveInbox?.status === 'resolved', 'applied change resolves approval inbox')
projection = projector.project(event('change.rejected', { eventId, changeType: 'venue' }))
ok(projection.activity?.action === 'change.rejected' && projection.resolveInbox?.status === 'dismissed', 'rejected change dismisses approval inbox')
projection = projector.project(event('message.delivered', {}))
ok(projection.activity === null && projection.inbox === null, 'delivery status does not pollute operations')

projection = projector.project(event('dependency.detected', { eventId, title: 'Ajustar horário do Buffet X', action: 'suggest_update', severity: 'warning' }))
ok(projection.activity === null && projection.inbox?.type === 'dependency_suggestion' && projection.inbox.sourceType === 'dependency_impact', 'dependency suggestion becomes inbox')
projection = projector.project(event('dependency.evaluation_completed', { eventId, impactCount: 3 }))
ok(projection.activity?.action === 'dependency.evaluation_completed' && projection.inbox === null, 'dependency evaluation becomes summary activity')
projection = projector.project(event('dependency.applied', { eventId, title: 'Ajustar horário do Buffet X' }))
ok(projection.activity?.action === 'dependency.applied' && projection.resolveInbox?.status === 'resolved', 'applied dependency resolves inbox')
projection = projector.project(event('dependency.dismissed', { eventId, title: 'Revisar logística' }))
ok(projection.activity?.action === 'dependency.dismissed' && projection.resolveInbox?.status === 'dismissed', 'dismissed dependency dismisses inbox')
console.log(`OperationalProjector scenarios: ${passed}/14`)
