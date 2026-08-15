export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_TYPES = ['general', 'confirmation', 'document', 'payment', 'guest', 'briefing', 'other'] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const TASK_SOURCES = ['manual', 'template', 'automation', 'dependency', 'ai'] as const
export type TaskSource = (typeof TASK_SOURCES)[number]

export interface EventTask {
  id: string
  organizationId: string
  eventId: string
  templateTaskId: string | null
  sourceCommandRequestId: string | null
  title: string
  description: string | null
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  dueAt: Date
  source: TaskSource
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface CreateManualTaskInput {
  organizationId: string
  eventId: string
  title: string
  description?: string | null
  type?: TaskType
  priority?: TaskPriority
  dueAt: Date
  source?: TaskSource
  sourceCommandRequestId?: string | null
}

export interface UpdateTaskInput {
  organizationId: string
  eventId: string
  taskId: string
  status?: TaskStatus
  priority?: TaskPriority
  dueAt?: Date
  title?: string
  description?: string | null
}
