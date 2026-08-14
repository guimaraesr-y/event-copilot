import type { OperationalProjection, OutboxMessage } from '@ecc/domain'

export class OperationalProjector {
  project(message: OutboxMessage): OperationalProjection {
    const p = message.payload
    const eventId = uuidString(p.eventId)

    switch (message.eventType) {
      case 'event.created': {
        const name = text(p.name) ?? 'Evento'
        return {
          activity: activity(eventId ?? message.aggregateId, 'system', 'event', 'event.created', 'event', message.aggregateId, `Evento ${name} criado`, null, p),
          inbox: null,
        }
      }
      case 'vendor.attached': {
        const vendorName = text(p.vendorName) ?? 'Fornecedor'
        return {
          activity: activity(eventId, 'system', 'vendor', 'vendor.attached', 'event_vendor', message.aggregateId, `${vendorName} adicionado ao evento`, null, p),
          inbox: null,
        }
      }
      case 'vendor.confirmation_requested': {
        const vendorName = text(p.vendorName) ?? 'Fornecedor'
        return {
          activity: activity(eventId, 'automation', 'vendor', 'vendor.confirmation_requested', 'event_vendor', message.aggregateId, `Confirmação solicitada a ${vendorName}`, null, p),
          inbox: null,
        }
      }
      case 'vendor.confirmed': {
        const vendorName = text(p.vendorName) ?? 'Fornecedor'
        const details = [
          text(p.arrivalAt) ? `Chegada: ${text(p.arrivalAt)}` : null,
          typeof p.teamSize === 'number' ? `Equipe: ${p.teamSize}` : null,
        ].filter(Boolean).join(' · ') || null
        return {
          activity: activity(eventId, 'vendor', 'vendor', 'vendor.confirmed', 'event_vendor', message.aggregateId, `${vendorName} confirmou participação`, details, p),
          inbox: null,
        }
      }
      case 'vendor.declined': {
        const vendorName = text(p.vendorName) ?? 'Fornecedor'
        return {
          activity: activity(eventId, 'vendor', 'vendor', 'vendor.declined', 'event_vendor', message.aggregateId, `${vendorName} recusou participação`, null, p),
          inbox: inbox(eventId, 'vendor_declined', 'critical', 'event_vendor', message.aggregateId, `${vendorName} recusou participação`, 'É necessário revisar a cobertura deste fornecedor para o evento.', p),
        }
      }
      case 'message.received': {
        const body = text(p.text)
        return {
          activity: activity(eventId, 'vendor', 'message', 'message.received', 'inbound_message', message.aggregateId, 'Fornecedor respondeu à confirmação', body ? truncate(body, 240) : null, p),
          inbox: null,
        }
      }
      case 'message.failed': {
        const error = text(p.error) ?? 'Falha reportada pelo provider de mensagens'
        return {
          activity: null,
          inbox: inbox(eventId, 'message_failed', 'warning', 'outbound_message', message.aggregateId, 'Falha ao enviar mensagem', truncate(error, 500), p),
        }
      }
      case 'message.review_required': {
        const reason = text(p.reason) ?? 'A mensagem recebida precisa de revisão humana.'
        return {
          activity: null,
          inbox: inbox(eventId, 'inbound_message_review', 'warning', 'inbound_message', message.aggregateId, 'Resposta de fornecedor precisa de revisão', truncate(reason, 500), p),
        }
      }
      case 'task.completed': {
        return {
          activity: activity(eventId, 'system', 'task', 'task.completed', 'task', message.aggregateId, 'Tarefa concluída', null, p),
          inbox: null,
        }
      }
      default:
        return { activity: null, inbox: null }
    }
  }
}

function activity(
  eventId: string | null,
  actorType: 'user' | 'system' | 'vendor' | 'client' | 'automation',
  category: 'event' | 'task' | 'vendor' | 'message' | 'document' | 'payment' | 'change' | 'risk' | 'system',
  action: string,
  entityType: string,
  entityId: string | null,
  title: string,
  description: string | null,
  metadata: Record<string, unknown>,
) {
  return { eventId, actorType, actorId: null, category, action, entityType, entityId, title, description, metadata }
}

function inbox(
  eventId: string | null,
  type: string,
  severity: 'info' | 'warning' | 'critical',
  sourceType: string,
  sourceId: string | null,
  title: string,
  description: string | null,
  metadata: Record<string, unknown>,
) {
  return { eventId, type, severity, sourceType, sourceId, title, description, assignedTo: null, metadata }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
function uuidString(value: unknown): string | null {
  const valueText = text(value)
  return valueText && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valueText) ? valueText : null
}
function truncate(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…` }
