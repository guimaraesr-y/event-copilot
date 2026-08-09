export const MILESTONE_STATUSES = ['pending', 'reached', 'missed', 'cancelled'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export const MILESTONE_SOURCES = ['manual', 'template', 'automation'] as const
export type MilestoneSource = (typeof MILESTONE_SOURCES)[number]

export interface EventMilestone {
  id: string
  organizationId: string
  eventId: string
  templateMilestoneId: string | null
  name: string
  description: string | null
  dueAt: Date
  status: MilestoneStatus
  source: MilestoneSource
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}
