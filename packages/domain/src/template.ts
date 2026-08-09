import type { EventType } from './event.ts'
import type { TaskPriority, TaskType } from './task.ts'

export interface EventTemplate {
  id: string
  organizationId: string
  name: string
  eventType: EventType
  description: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface EventTemplateTask {
  id: string
  organizationId: string
  templateId: string
  title: string
  description: string | null
  offsetDays: number
  dueTime: string
  priority: TaskPriority
  type: TaskType
  sortOrder: number
  createdAt: Date
}

export interface EventTemplateMilestone {
  id: string
  organizationId: string
  templateId: string
  name: string
  description: string | null
  offsetDays: number
  dueTime: string
  sortOrder: number
  createdAt: Date
}

export interface EventTemplateSnapshot extends EventTemplate {
  tasks: EventTemplateTask[]
  milestones: EventTemplateMilestone[]
}
