import type { DomainEvent } from './outbox.ts'
import type { Event } from './event.ts'

export const EVENT_DAY_SESSION_STATUSES = ['active','completed'] as const
export type EventDaySessionStatus = (typeof EVENT_DAY_SESSION_STATUSES)[number]

export const EVENT_DAY_OPERATIONAL_STATUSES = ['not_started','on_track','attention','critical','completed'] as const
export type EventDayOperationalStatus = (typeof EVENT_DAY_OPERATIONAL_STATUSES)[number]

export const EVENT_DAY_VENDOR_STATUSES = ['unscheduled','not_due','due','late','arrived','departed'] as const
export type EventDayVendorStatus = (typeof EVENT_DAY_VENDOR_STATUSES)[number]

export const EVENT_DAY_ACTIVITY_TYPES = ['event_day.started','vendor.arrived','vendor.departed','event_day.completed'] as const
export type EventDayActivityType = (typeof EVENT_DAY_ACTIVITY_TYPES)[number]

export interface EventDaySession {
  id: string
  organizationId: string
  eventId: string
  status: EventDaySessionStatus
  startedAt: Date
  completedAt: Date | null
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
  status: string
  priority: 'low'|'normal'|'high'|'critical'
  dueAt: Date
}

export interface EventDaySource {
  organizationId: string
  timezone: string
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
  status: string
  priority: 'low'|'normal'|'high'|'critical'
  dueAt: string
  overdue: boolean
}

export interface EventDayTimelineItem {
  at: string
  source: 'planned'|'actual'
  type: 'session_started'|'vendor_arrival_planned'|'vendor_arrived'|'event_start'|'event_end'|'vendor_departure_planned'|'vendor_departed'|'session_completed'
  title: string
  detail: string | null
  eventVendorId: string | null
}

export interface EventDaySnapshot {
  organizationId: string
  eventId: string
  eventName: string
  timezone: string
  now: string
  operationalStatus: EventDayOperationalStatus
  session: {
    id: string
    status: EventDaySessionStatus
    startedAt: string
    completedAt: string | null
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
    openTasks: number
    overdueTasks: number
    criticalOpenTasks: number
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

export interface EventDayStore {
  loadSource(organizationId:string,eventId:string):Promise<EventDaySource|null>
  startSession(input:{session:EventDaySession;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{session:EventDaySession;duplicate:boolean}>
  markVendorArrived(input:{organizationId:string;eventId:string;eventVendorId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
  markVendorDeparted(input:{organizationId:string;eventId:string;eventVendorId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
  completeSession(input:{organizationId:string;eventId:string;at:Date;sender:string;activity:EventDayActivity;domainEvent:DomainEvent}):Promise<{duplicate:boolean}>
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
