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

export interface ScheduledBriefPreference extends BriefPreference {
  organizationName: string
  timezone: string
}

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

export interface PersistDailyBriefInput {
  brief: Omit<DailyBrief,'revision'|'status'|'supersededAt'>
  requestDelivery: boolean
  recipient: string | null
  domainEvent: DomainEvent | null
}

export interface BriefStore {
  getPreference(organizationId:string):Promise<BriefPreference>
  updatePreference(input:{organizationId:string;enabled?:boolean;localTime?:string;recipient?:string|null;updatedBySender:string|null;at:Date}):Promise<BriefPreference>
  listScheduledPreferences():Promise<ScheduledBriefPreference[]>
  loadDailySnapshot(organizationId:string):Promise<DailyBriefSnapshot|null>
  persistDaily(input:PersistDailyBriefInput):Promise<{brief:DailyBrief;duplicate:boolean}>
  getLatestDaily(organizationId:string,referenceDate:string):Promise<DailyBrief|null>
  getById(organizationId:string,briefId:string):Promise<DailyBrief|null>
  listDaily(organizationId:string,limit?:number):Promise<DailyBrief[]>
}

export class BriefValidationError extends Error { readonly code='BRIEF_VALIDATION_ERROR'; constructor(message:string){super(message);this.name='BriefValidationError'} }
export class BriefNotFoundError extends Error { readonly code='BRIEF_NOT_FOUND'; constructor(message='Brief not found'){super(message);this.name='BriefNotFoundError'} }
