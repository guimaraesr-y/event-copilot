import type { ColumnType, Generated, JSONColumnType } from 'kysely'

export interface OrganizationsTable {
  id: string
  name: string
  timezone: string
  settings: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface EventsTable {
  id: string
  organization_id: string
  template_id: string | null
  name: string
  type: 'wedding' | 'birthday' | 'corporate' | 'other'
  start_at: ColumnType<Date, Date | string, Date | string>
  end_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  venue_name: string | null
  venue_address: string | null
  guest_count: number
  status: 'draft' | 'planning' | 'confirmation' | 'ready' | 'event_day' | 'completed' | 'cancelled'
  health_score: number
  owner_user_id: string | null
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface EventTemplatesTable {
  id: string
  organization_id: string
  name: string
  event_type: 'wedding' | 'birthday' | 'corporate' | 'other'
  description: string | null
  is_active: boolean
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface EventTemplateTasksTable {
  id: string
  organization_id: string
  template_id: string
  title: string
  description: string | null
  offset_days: number
  due_time: string
  priority: 'low' | 'normal' | 'high' | 'critical'
  type: 'general' | 'confirmation' | 'document' | 'payment' | 'guest' | 'briefing' | 'other'
  sort_order: number
  created_at: ColumnType<Date, Date | string, never>
}

export interface EventTemplateMilestonesTable {
  id: string
  organization_id: string
  template_id: string
  name: string
  description: string | null
  offset_days: number
  due_time: string
  sort_order: number
  created_at: ColumnType<Date, Date | string, never>
}

export interface EventTasksTable {
  id: string
  organization_id: string
  event_id: string
  template_task_id: string | null
  title: string
  description: string | null
  type: 'general' | 'confirmation' | 'document' | 'payment' | 'guest' | 'briefing' | 'other'
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'low' | 'normal' | 'high' | 'critical'
  due_at: ColumnType<Date, Date | string, Date | string>
  source: 'manual' | 'template' | 'automation' | 'dependency' | 'ai'
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
}

export interface EventMilestonesTable {
  id: string
  organization_id: string
  event_id: string
  template_milestone_id: string | null
  name: string
  description: string | null
  due_at: ColumnType<Date, Date | string, Date | string>
  status: 'pending' | 'reached' | 'missed' | 'cancelled'
  source: 'manual' | 'template' | 'automation'
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
}

export interface OutboxEventsTable {
  id: string
  organization_id: string
  event_type: string
  aggregate_type: string
  aggregate_id: string
  payload: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  occurred_at: ColumnType<Date, Date | string, never>
  created_at: Generated<Date>
  available_at: ColumnType<Date, Date | string, Date | string>
  attempts: Generated<number>
  claimed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  claimed_by: string | null
  dispatched_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  last_error: string | null
}

export interface DatabaseSchema {
  organizations: OrganizationsTable
  events: EventsTable
  event_templates: EventTemplatesTable
  event_template_tasks: EventTemplateTasksTable
  event_template_milestones: EventTemplateMilestonesTable
  event_tasks: EventTasksTable
  event_milestones: EventMilestonesTable
  outbox_events: OutboxEventsTable
}
