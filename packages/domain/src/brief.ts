import type { DomainEvent } from './outbox.ts'
import type { HealthStatus } from './health.ts'
import type { RiskSeverity } from './risk.ts'

export const BRIEF_TYPES = ['daily','d_minus_1'] as const
export type BriefType = (typeof BRIEF_TYPES)[number]
export const BRIEF_STATUSES = ['generated','superseded'] as const
export type BriefStatus = (typeof BRIEF_STATUSES)[number]
export const BRIEF_TRIGGER_TYPES = ['scheduled','manual','agent'] as const
export type BriefTriggerType = (typeof BRIEF_TRIGGER_TYPES)[number]
export const BRIEF_PRIORITY_TYPES = ['risk','task','vendor','dependency','change','inbox'] as const
export type BriefPriorityType = (typeof BRIEF_PRIORITY_TYPES)[number]
export const EVENT_READINESS_STATUSES = ['READY','READY_WITH_WARNINGS','NOT_READY'] as const
export type EventReadinessStatus = (typeof EVENT_READINESS_STATUSES)[number]

export interface BriefPreference {
  organizationId: string
  enabled: boolean
  localTime: string
  channel: 'whatsapp'
  recipient: string | null
  updatedBySender: string | null
  createdAt: Date
  updatedAt: Date
}

export interface BriefSchedule extends BriefPreference { type: BriefType }
export interface ScheduledBriefPreference extends BriefPreference { organizationName: string; timezone: string }
export interface ScheduledBriefSchedule extends BriefSchedule { organizationName: string; timezone: string }

export interface BriefPriorityItem {
  rank: number
  type: BriefPriorityType
  eventId: string
  eventName: string
  sourceId: string | null
  severity: RiskSeverity | 'normal'
  score: number
  title: string
  reason: string
}

export interface BriefEventSummary {
  eventId: string
  eventName: string
  eventStartAt: string
  daysUntil: number
  healthScore: number
  healthStatus: HealthStatus
  priorityScore: number
  activeRisks: number
  criticalRisks: number
  highRisks: number
  overdueTasks: number
  dueTodayTasks: number
  pendingVendors: number
  declinedVendors: number
  openDependencies: number
  pendingChanges: number
  openInbox: number
}

export interface DailyBriefSummary {
  referenceDate: string
  timezone: string
  activeEvents: number
  criticalEvents: number
  attentionEvents: number
  overdueTasks: number
  dueTodayTasks: number
  pendingVendors: number
  openDependencies: number
  pendingChanges: number
  openInbox: number
  events: BriefEventSummary[]
  priorities: BriefPriorityItem[]
}

export interface DailyBrief {
  id: string
  organizationId: string
  type: 'daily'
  eventId: null
  referenceDate: string
  revision: number
  status: BriefStatus
  triggerType: BriefTriggerType
  triggerKey: string
  summary: DailyBriefSummary
  renderedText: string
  generatedBySender: string | null
  generatedAt: Date
  supersededAt: Date | null
  deliveryRequestedAt: Date | null
}

export interface DMinus1RiskItem { id:string; severity:RiskSeverity; score:number; title:string; status:'open'|'acknowledged' }
export interface DMinus1TaskItem { id:string; title:string; priority:'low'|'normal'|'high'|'critical'; dueAt:string; overdue:boolean }
export interface DMinus1MilestoneItem { id:string; name:string; dueAt:string; status:string; overdue:boolean }
export interface DMinus1VendorItem { id:string; vendorName:string; category:string; confirmationStatus:string; arrivalAt:string|null; departureAt:string|null }
export interface DMinus1DependencyItem { id:string; severity:'info'|'warning'|'critical'; title:string }
export interface DMinus1ChangeItem { id:string; type:string }
export interface DMinus1InboxItem { id:string; severity:'info'|'warning'|'critical'; title:string }
export interface DMinus1TimelineItem { at:string; type:'vendor_arrival'|'event_start'|'event_end'|'vendor_departure'; title:string; detail:string|null }

export interface DMinus1BriefSummary {
  referenceDate: string
  timezone: string
  readiness: EventReadinessStatus
  readinessReasons: string[]
  event: {
    eventId:string
    eventName:string
    startAt:string
    endAt:string|null
    venueName:string|null
    venueAddress:string|null
    guestCount:number
    healthScore:number
    healthStatus:HealthStatus
  }
  counts: {
    activeRisks:number
    criticalRisks:number
    highRisks:number
    openTasks:number
    overdueTasks:number
    criticalOpenTasks:number
    openMilestones:number
    confirmedVendors:number
    pendingVendors:number
    declinedVendors:number
    openDependencies:number
    pendingChanges:number
    openInbox:number
  }
  risks:DMinus1RiskItem[]
  tasks:DMinus1TaskItem[]
  milestones:DMinus1MilestoneItem[]
  vendors:DMinus1VendorItem[]
  dependencies:DMinus1DependencyItem[]
  changes:DMinus1ChangeItem[]
  inbox:DMinus1InboxItem[]
  timeline:DMinus1TimelineItem[]
}

export interface DMinus1Brief {
  id:string
  organizationId:string
  type:'d_minus_1'
  eventId:string
  referenceDate:string
  revision:number
  status:BriefStatus
  triggerType:BriefTriggerType
  triggerKey:string
  summary:DMinus1BriefSummary
  renderedText:string
  generatedBySender:string|null
  generatedAt:Date
  supersededAt:Date|null
  deliveryRequestedAt:Date|null
}

export type OperationalBrief = DailyBrief | DMinus1Brief
export type OperationalBriefSummary = DailyBriefSummary | DMinus1BriefSummary

export interface BriefSnapshotEvent {
  id: string
  name: string
  startAt: Date
  status: string
  healthScore: number
}
export interface BriefSnapshotTask {
  id: string
  eventId: string
  title: string
  status: string
  priority: 'low'|'normal'|'high'|'critical'
  dueAt: Date
}
export interface BriefSnapshotVendor {
  id: string
  eventId: string
  vendorName: string
  confirmationStatus: string
}
export interface BriefSnapshotRisk {
  id: string
  eventId: string
  severity: RiskSeverity
  score: number
  title: string
  description: string
  status: 'open'|'acknowledged'
}
export interface BriefSnapshotDependency { id:string; eventId:string; severity:'info'|'warning'|'critical'; title:string }
export interface BriefSnapshotChange { id:string; eventId:string; type:string }
export interface BriefSnapshotInbox { id:string; eventId:string|null; severity:'info'|'warning'|'critical'; title:string }

export interface DailyBriefSnapshot {
  organizationId: string
  organizationName: string
  timezone: string
  events: BriefSnapshotEvent[]
  tasks: BriefSnapshotTask[]
  vendors: BriefSnapshotVendor[]
  risks: BriefSnapshotRisk[]
  dependencies: BriefSnapshotDependency[]
  changes: BriefSnapshotChange[]
  inbox: BriefSnapshotInbox[]
}

export interface DMinus1BriefSnapshot {
  organizationId:string
  organizationName:string
  timezone:string
  event:{id:string;name:string;startAt:Date;endAt:Date|null;status:string;healthScore:number;venueName:string|null;venueAddress:string|null;guestCount:number}
  tasks:Array<{id:string;title:string;status:string;priority:'low'|'normal'|'high'|'critical';dueAt:Date}>
  milestones:Array<{id:string;name:string;status:string;dueAt:Date}>
  vendors:Array<{id:string;vendorName:string;category:string;confirmationStatus:string;arrivalAt:Date|null;departureAt:Date|null}>
  risks:Array<{id:string;severity:RiskSeverity;score:number;title:string;description:string;status:'open'|'acknowledged'}>
  dependencies:Array<{id:string;severity:'info'|'warning'|'critical';title:string}>
  changes:Array<{id:string;type:string}>
  inbox:Array<{id:string;severity:'info'|'warning'|'critical';title:string}>
}

export interface PersistDailyBriefInput {
  brief: Omit<DailyBrief,'revision'|'status'|'supersededAt'>
  requestDelivery: boolean
  recipient: string | null
  domainEvent: DomainEvent | null
}
export interface PersistDMinus1BriefInput {
  brief: Omit<DMinus1Brief,'revision'|'status'|'supersededAt'>
  requestDelivery:boolean
  recipient:string|null
  domainEvent:DomainEvent|null
}

export interface BriefStore {
  getPreference(organizationId:string):Promise<BriefPreference>
  updatePreference(input:{organizationId:string;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;at:Date}):Promise<BriefPreference>
  listScheduledPreferences():Promise<ScheduledBriefPreference[]>
  getSchedule(organizationId:string,type:BriefType):Promise<BriefSchedule>
  updateSchedule(input:{organizationId:string;type:BriefType;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;at:Date}):Promise<BriefSchedule>
  listScheduledSchedules(type?:BriefType):Promise<ScheduledBriefSchedule[]>
  loadDailySnapshot(organizationId:string):Promise<DailyBriefSnapshot|null>
  loadDMinus1Snapshot(organizationId:string,eventId:string):Promise<DMinus1BriefSnapshot|null>
  persistDaily(input:PersistDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>
  persistDMinus1(input:PersistDMinus1BriefInput):Promise<{brief:DMinus1Brief;duplicate:boolean}>
  getLatestDaily(organizationId:string,referenceDate:string):Promise<DailyBrief|null>
  getLatestDMinus1(organizationId:string,eventId:string):Promise<DMinus1Brief|null>
  getById(organizationId:string,briefId:string):Promise<OperationalBrief|null>
  listDaily(organizationId:string,limit?:number):Promise<DailyBrief[]>
  listDMinus1(organizationId:string,eventId?:string,limit?:number):Promise<DMinus1Brief[]>
}

export class BriefValidationError extends Error { readonly code='BRIEF_VALIDATION_ERROR'; constructor(message:string){super(message);this.name='BriefValidationError'} }
export class BriefNotFoundError extends Error { readonly code='BRIEF_NOT_FOUND'; constructor(message='Brief not found'){super(message);this.name='BriefNotFoundError'} }
