import type { DomainEvent } from './outbox.ts'
import type { Event, EventStatus } from './event.ts'

export const EVENT_DAY_SESSION_STATUSES = ['active','completed'] as const
export type EventDaySessionStatus = (typeof EVENT_DAY_SESSION_STATUSES)[number]

export const EVENT_DAY_COMPLETION_REASONS = ['manual','disabled'] as const
export type EventDayCompletionReason = (typeof EVENT_DAY_COMPLETION_REASONS)[number]

export const EVENT_DAY_OPERATIONAL_STATUSES = ['disabled','not_started','on_track','attention','critical','completed'] as const
export type EventDayOperationalStatus = (typeof EVENT_DAY_OPERATIONAL_STATUSES)[number]

export const EVENT_DAY_VENDOR_STATUSES = ['unscheduled','not_due','due','late','arrived','departed'] as const
export type EventDayVendorStatus = (typeof EVENT_DAY_VENDOR_STATUSES)[number]

export const EVENT_DAY_TASK_KINDS = ['checklist','operation','incident'] as const
export type EventDayTaskKind = (typeof EVENT_DAY_TASK_KINDS)[number]

export const EVENT_DAY_TASK_STATUSES = ['pending','in_progress','completed','cancelled'] as const
export type EventDayTaskStatus = (typeof EVENT_DAY_TASK_STATUSES)[number]

export const EVENT_DAY_TASK_PRIORITIES = ['low','normal','high','critical'] as const
export type EventDayTaskPriority = (typeof EVENT_DAY_TASK_PRIORITIES)[number]

export const EVENT_DAY_ACTIVITY_TYPES = ['event_day.started','vendor.arrived','vendor.departed','event_day.completed'] as const
export type EventDayActivityType = (typeof EVENT_DAY_ACTIVITY_TYPES)[number]

export interface EventDayConfiguration {
  organizationId: string
  eventId: string
  enabled: boolean
  updatedAt: Date
  updatedBySender: string
}

export interface EventDaySession {
  id: string
  organizationId: string
  eventId: string
  status: EventDaySessionStatus
  previousEventStatus: EventStatus
  startedAt: Date
  completedAt: Date | null
  completionReason: EventDayCompletionReason | null
  startedBySender: string
  completedBySender: string | null
  createdAt: Date
  updatedAt: Date
}

export interface EventDayActivity {
  id: string
  organizationId: string
  eventId: string
  sessionId: string
  eventVendorId: string | null
  type: EventDayActivityType
  occurredAt: Date
  createdBySender: string
  note: string | null
  createdAt: Date
}

export interface EventDaySourceVendor {
  id: string
  vendorName: string
  category: string
  confirmationStatus: string
  plannedArrivalAt: Date | null
  plannedDepartureAt: Date | null
  actualArrivalAt: Date | null
  actualDepartureAt: Date | null
}

export interface EventDaySourceTask {
  id: string
  title: string
  description: string | null
  kind: EventDayTaskKind
  status: EventDayTaskStatus
  priority: EventDayTaskPriority
  dueAt: Date
  source: 'manual'|'automation'|'ai'
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface EventDaySource {
  organizationId: string
  timezone: string
  enabled: boolean
  event: Event
  session: EventDaySession | null
  vendors: EventDaySourceVendor[]
  tasks: EventDaySourceTask[]
  activity: EventDayActivity[]
}

export interface EventDayVendorSnapshot {
  eventVendorId: string
  vendorName: string
  category: string
  confirmationStatus: string
  plannedArrivalAt: string | null
  plannedDepartureAt: string | null
  actualArrivalAt: string | null
  actualDepartureAt: string | null
  liveStatus: EventDayVendorStatus
  minutesLate: number
}

export interface EventDayTaskSnapshot {
  id: string
  title: string
  description: string | null
  kind: EventDayTaskKind
  status: EventDayTaskStatus
  priority: EventDayTaskPriority
  dueAt: string
  overdue: boolean
  source: 'manual'|'automation'|'ai'
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface EventDayTimelineItem {
  at: string
  source: 'planned'|'actual'
  type: 'session_started'|'vendor_arrival_planned'|'vendor_arrived'|'event_start'|'event_end'|'vendor_departure_planned'|'vendor_departed'|'task_due'|'session_completed'
  title: string
  detail: string | null
  eventVendorId: string | null
  taskId: string | null
}

export interface EventDaySnapshot {
  organizationId: string
  eventId: string
  eventName: string
  timezone: string
  now: string
  enabled: boolean
  operationalStatus: EventDayOperationalStatus
  session: {
    id: string
    status: EventDaySessionStatus
    previousEventStatus: EventStatus
    startedAt: string
    completedAt: string | null
    completionReason: EventDayCompletionReason | null
    startedBySender: string
    completedBySender: string | null
  } | null
  event: {
    startAt: string
    endAt: string | null
    status: Event['status']
    venueName: string | null
    venueAddress: string | null
    guestCount: number
    healthScore: number
  }
  counts: {
    vendors: number
    arrivedVendors: number
    lateVendors: number
    dueVendors: number
    unconfirmedVendors: number
    departedVendors: number
    tasks: number
    openTasks: number
    overdueTasks: number
    criticalOpenTasks: number
    incidents: number
    openIncidents: number
    criticalOpenIncidents: number
    resolvedIncidents: number
  }
  vendors: EventDayVendorSnapshot[]
  tasks: EventDayTaskSnapshot[]
  timeline: EventDayTimelineItem[]
  nextActions: string[]
}

export interface EventDayMutationResult {
  snapshot: EventDaySnapshot
  duplicate: boolean
}

export interface EventDayTaskMutationResult extends EventDayMutationResult {
  task: EventDayTaskSnapshot
}

export interface EventDayTaskRecord {
  id: string
  organizationId: string
  eventId: string
  title: string
  description: string | null
  kind: EventDayTaskKind
  status: EventDayTaskStatus
  priority: EventDayTaskPriority
  dueAt: Date
  source: 'manual'|'automation'|'ai'
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface EventDayStore {
  loadSource(organizationId:string,eventId:string):Promise<EventDaySource|null>
  enable(input:{organizationId:string;eventId:string;at:Date;sender:string;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
  disable(input:{organizationId:string;eventId:string;at:Date;sender:string;activity:EventDayActivity|null;domainEvent:DomainEvent}):Promise<{duplicate:boolean;sessionCompleted:boolean}>
  startSession(input:{session:EventDaySession;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{session:EventDaySession;duplicate:boolean}>
  markVendorArrived(input:{organizationId:string;eventId:string;eventVendorId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
  markVendorDeparted(input:{organizationId:string;eventId:string;eventVendorId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
  completeSession(input:{organizationId:string;eventId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
  createTask(input:{task:EventDayTaskRecord;domainEvent:DomainEvent}):Promise<void>
  updateTask(input:{organizationId:string;eventId:string;taskId:string;status:EventDayTaskStatus;at:Date;sender:string;domainEvent:DomainEvent}):Promise<{duplicate:boolean;task:EventDayTaskRecord}>
}

export class EventDayValidationError extends Error {
  readonly code='EVENT_DAY_VALIDATION_ERROR'
  constructor(message:string){super(message);this.name='EventDayValidationError'}
}
export class EventDayNotFoundError extends Error {
  readonly code='EVENT_DAY_NOT_FOUND'
  constructor(message='Event not found'){super(message);this.name='EventDayNotFoundError'}
}
export class EventDayConflictError extends Error {
  readonly code='EVENT_DAY_CONFLICT'
  constructor(message:string){super(message);this.name='EventDayConflictError'}
}
