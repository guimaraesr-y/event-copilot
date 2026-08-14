import type { OutboxMessage } from './outbox.ts'

export const ACTIVITY_ACTOR_TYPES = ['user','system','vendor','client','automation'] as const
export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number]

export const ACTIVITY_CATEGORIES = ['event','task','vendor','message','document','payment','change','risk','system'] as const
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

export const INBOX_SEVERITIES = ['info','warning','critical'] as const
export type InboxSeverity = (typeof INBOX_SEVERITIES)[number]

export const INBOX_STATUSES = ['open','in_progress','resolved','dismissed'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]

export interface ActivityEntry {
  id: string
  organizationId: string
  eventId: string | null
  sourceEventId: string
  actorType: ActivityActorType
  actorId: string | null
  category: ActivityCategory
  action: string
  entityType: string
  entityId: string | null
  title: string
  description: string | null
  metadata: Record<string, unknown>
  occurredAt: Date
  createdAt: Date
}

export interface InboxItem {
  id: string
  organizationId: string
  eventId: string | null
  sourceEventId: string
  type: string
  severity: InboxSeverity
  sourceType: string
  sourceId: string | null
  title: string
  description: string | null
  status: InboxStatus
  assignedTo: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

export type ActivityDraft = Omit<ActivityEntry, 'id' | 'organizationId' | 'sourceEventId' | 'createdAt' | 'occurredAt'>
export type InboxDraft = Omit<InboxItem, 'id' | 'organizationId' | 'sourceEventId' | 'createdAt' | 'updatedAt' | 'resolvedAt' | 'status'>

export interface OperationalProjection {
  activity: ActivityDraft | null
  inbox: InboxDraft | null
}

export interface OperationalProjectionStore {
  applyProjection(message: OutboxMessage, projection: OperationalProjection, at?: Date): Promise<void>
}
