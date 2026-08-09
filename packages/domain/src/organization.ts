export interface Organization {
  id: string
  name: string
  timezone: string
  settings: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}
