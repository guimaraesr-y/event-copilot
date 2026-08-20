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
  source_command_request_id: string | null
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


export interface VendorsTable {
  id: string
  organization_id: string
  name: string
  category: 'buffet' | 'photo' | 'video' | 'decoration' | 'dj' | 'band' | 'cake' | 'sweets' | 'venue' | 'transport' | 'celebrant' | 'security' | 'other'
  contact_name: string | null
  phone: string | null
  email: string | null
  notes: string | null
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface EventVendorsTable {
  id: string
  organization_id: string
  event_id: string
  vendor_id: string
  vendor_name: string
  category: VendorsTable['category']
  contact_name: string | null
  phone: string | null
  email: string | null
  confirmation_status: 'pending' | 'requested' | 'confirmed' | 'declined' | 'cancelled'
  contract_status: 'not_applicable' | 'pending' | 'signed'
  payment_status: 'not_applicable' | 'pending' | 'partial' | 'paid' | 'overdue'
  arrival_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  departure_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  team_size: number | null
  confirmation_requested_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  confirmation_deadline_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  confirmed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  declined_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  notes: string | null
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}


export interface AutomationActionsTable {
  id: string
  organization_id: string
  source_outbox_event_id: string
  source_event_type: string
  aggregate_type: string
  aggregate_id: string
  action_type: string
  status: 'prepared' | 'processing' | 'completed' | 'failed' | 'cancelled'
  payload: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface OutboundMessagesTable {
  id: string
  organization_id: string
  source_action_id: string
  channel: 'whatsapp' | 'email' | 'sms'
  provider: 'mock' | 'meta'
  recipient: string
  message_type: string
  aggregate_type: string
  aggregate_id: string
  status: 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  external_message_id: string | null
  payload: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  provider_response: JSONColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  sent_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  delivered_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  read_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  failed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  last_error: string | null
}


export interface MessagingWebhookEventsTable {
  id: string
  provider: 'mock' | 'meta'
  external_event_id: string
  event_type: 'message.status' | 'message.received'
  status: 'received' | 'processed' | 'ignored' | 'failed'
  payload_hash: string
  canonical_payload: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  raw_payload: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  received_at: ColumnType<Date, Date | string, Date | string>
  processed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  last_error: string | null
}


export interface InboundMessagesTable {
  id: string
  organization_id: string | null
  webhook_event_id: string
  provider: 'mock' | 'meta'
  external_message_id: string
  sender: string
  recipient: string | null
  content_type: 'text' | 'media'
  text: string | null
  content: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  status: 'received' | 'resolved' | 'processing' | 'processed' | 'needs_review' | 'ignored' | 'failed'
  resolved_event_id: string | null
  resolved_event_vendor_id: string | null
  candidate_event_vendor_ids: JSONColumnType<string[], string[], string[]>
  interpretation: JSONColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>
  received_at: ColumnType<Date, Date | string, Date | string>
  processed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  last_error: string | null
}


export interface CommandRequestsTable {
  id: string
  organization_id: string
  sender: string
  idempotency_key: string
  raw_text: string
  explicit_event_id: string | null
  resolved_event_id: string | null
  interpreter: 'rule_based' | 'ai' | 'agent'
  intent: import('@ecc/domain').CommandIntent | null
  confidence: number | null
  status: import('@ecc/domain').CommandStatus
  interpretation: JSONColumnType<import('@ecc/domain').CommandInterpretation | null, import('@ecc/domain').CommandInterpretation | null, import('@ecc/domain').CommandInterpretation | null>
  result: JSONColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  processed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  last_error: string | null
}

export interface ConversationContextsTable {
  id: string
  organization_id: string
  sender: string
  current_event_id: string | null
  last_interaction_at: ColumnType<Date, Date | string, Date | string>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface EventNotesTable {
  id: string
  organization_id: string
  event_id: string
  source_command_request_id: string
  body: string
  created_by_sender: string
  source: 'command'
  created_at: ColumnType<Date, Date | string, never>
}

export interface ActivityEntriesTable {
  id: string
  organization_id: string
  event_id: string | null
  source_event_id: string
  actor_type: 'user' | 'system' | 'vendor' | 'client' | 'automation'
  actor_id: string | null
  category: 'event' | 'task' | 'vendor' | 'message' | 'document' | 'payment' | 'change' | 'risk' | 'system'
  action: string
  entity_type: string
  entity_id: string | null
  title: string
  description: string | null
  metadata: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  occurred_at: ColumnType<Date, Date | string, Date | string>
  created_at: ColumnType<Date, Date | string, never>
}

export interface InboxItemsTable {
  id: string
  organization_id: string
  event_id: string | null
  source_event_id: string
  type: string
  severity: 'info' | 'warning' | 'critical'
  source_type: string
  source_id: string | null
  title: string
  description: string | null
  status: 'open' | 'in_progress' | 'resolved' | 'dismissed'
  assigned_to: string | null
  metadata: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  resolved_at: ColumnType<Date | null, Date | string | null, Date | string | null>
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


export interface AgentTurnsTable {
  id: string
  organization_id: string
  sender: string
  idempotency_key: string
  user_text: string
  explicit_event_id: string | null
  assistant_text: string | null
  status: import('@ecc/domain').AgentTurnStatus
  provider: import('@ecc/domain').OperationalAgentProviderKind
  model: string
  model_calls: ColumnType<number, number | undefined, number>
  tool_trace: JSONColumnType<import('@ecc/domain').AgentToolTraceEntry[], string, string>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  last_error: string | null
}


export interface ChangeProposalsTable {
  id: string
  organization_id: string
  event_id: string
  requested_by_sender: string
  decided_by_sender: string | null
  source_agent_turn_id: string | null
  idempotency_key: string
  type: import('@ecc/domain').ChangeProposalType
  current_value: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  proposed_value: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  reason: string | null
  status: import('@ecc/domain').ChangeProposalStatus
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  decided_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  applied_at: ColumnType<Date | null, Date | string | null, Date | string | null>
}

export interface ChangeProposalImpactsTable {
  id: string
  organization_id: string
  proposal_id: string
  event_id: string
  category: import('@ecc/domain').ChangeImpactCategory
  severity: import('@ecc/domain').ChangeImpactSeverity
  title: string
  description: string
  metadata: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: ColumnType<Date, Date | string, never>
}



export interface DependencyEvaluationsTable {
  id: string
  organization_id: string
  event_id: string
  proposal_id: string
  source_change_event_id: string
  change_type: import('@ecc/domain').ChangeProposalType
  impact_count: number
  created_at: ColumnType<Date, Date | string, never>
}

export interface DependencyImpactsTable {
  id: string
  organization_id: string
  event_id: string
  proposal_id: string
  source_change_event_id: string
  rule_key: string
  dependency_type: import('@ecc/domain').DependencyType
  entity_type: import('@ecc/domain').DependencyEntityType
  entity_id: string
  action: import('@ecc/domain').DependencyAction
  severity: import('@ecc/domain').DependencySeverity
  status: import('@ecc/domain').DependencyStatus
  title: string
  description: string
  current_value: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  suggested_value: JSONColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>
  metadata: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
  resolved_at: ColumnType<Date | null, Date | string | null, Date | string | null>
}


export interface RiskEvaluationsTable {
  id: string
  organization_id: string
  event_id: string
  trigger_type: import('@ecc/domain').RiskTriggerType
  trigger_key: string
  detected_count: number
  updated_count: number
  resolved_count: number
  active_count: number
  evaluated_at: ColumnType<Date, Date | string, never>
}

export interface EventRisksTable {
  id: string
  organization_id: string
  event_id: string
  risk_key: string
  type: import('@ecc/domain').RiskType
  severity: import('@ecc/domain').RiskSeverity
  score: number
  status: import('@ecc/domain').RiskStatus
  source_type: import('@ecc/domain').RiskSourceType
  source_id: string | null
  title: string
  description: string
  metadata: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  first_detected_at: ColumnType<Date, Date | string, Date | string>
  last_detected_at: ColumnType<Date, Date | string, Date | string>
  acknowledged_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  acknowledged_by: string | null
  resolved_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}


export interface EventHealthEvaluationsTable {
  id: string
  organization_id: string
  event_id: string
  trigger_type: import('@ecc/domain').HealthTriggerType
  trigger_key: string
  previous_score: number
  score: number
  delta: number
  status: import('@ecc/domain').HealthStatus
  breakdown: JSONColumnType<import('@ecc/domain').HealthBreakdown, import('@ecc/domain').HealthBreakdown, import('@ecc/domain').HealthBreakdown>
  evaluated_at: ColumnType<Date, Date | string, never>
}


export interface OrganizationBriefPreferencesTable {
  organization_id: string
  enabled: boolean
  local_time: string
  channel: 'whatsapp'
  recipient: string | null
  updated_by_sender: string | null
  created_at: ColumnType<Date, Date | string, never>
  updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface DailyBriefsTable {
  id: string
  organization_id: string
  brief_type: import('@ecc/domain').BriefType
  reference_date: ColumnType<string, string, string>
  revision: number
  status: import('@ecc/domain').BriefStatus
  trigger_type: import('@ecc/domain').BriefTriggerType
  trigger_key: string
  summary: JSONColumnType<import('@ecc/domain').DailyBriefSummary, import('@ecc/domain').DailyBriefSummary, import('@ecc/domain').DailyBriefSummary>
  rendered_text: string
  generated_by_sender: string | null
  generated_at: ColumnType<Date, Date | string, never>
  superseded_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  delivery_requested_at: ColumnType<Date | null, Date | string | null, Date | string | null>
}

export interface DatabaseSchema {
  organizations: OrganizationsTable
  events: EventsTable
  event_templates: EventTemplatesTable
  event_template_tasks: EventTemplateTasksTable
  event_template_milestones: EventTemplateMilestonesTable
  event_tasks: EventTasksTable
  event_milestones: EventMilestonesTable
  vendors: VendorsTable
  event_vendors: EventVendorsTable
  automation_actions: AutomationActionsTable
  outbound_messages: OutboundMessagesTable
  messaging_webhook_events: MessagingWebhookEventsTable
  inbound_messages: InboundMessagesTable
  command_requests: CommandRequestsTable
  agent_turns: AgentTurnsTable
  change_proposals: ChangeProposalsTable
  change_proposal_impacts: ChangeProposalImpactsTable
  dependency_evaluations: DependencyEvaluationsTable
  dependency_impacts: DependencyImpactsTable
  risk_evaluations: RiskEvaluationsTable
  event_risks: EventRisksTable
  event_health_evaluations: EventHealthEvaluationsTable
  organization_brief_preferences: OrganizationBriefPreferencesTable
  daily_briefs: DailyBriefsTable
  conversation_contexts: ConversationContextsTable
  event_notes: EventNotesTable
  activity_entries: ActivityEntriesTable
  inbox_items: InboxItemsTable
  outbox_events: OutboxEventsTable
}
