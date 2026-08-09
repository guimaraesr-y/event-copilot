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
  outbox_events: OutboxEventsTable
}
