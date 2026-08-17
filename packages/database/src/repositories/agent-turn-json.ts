import type { AgentToolTraceEntry } from '@ecc/domain'

/**
 * node-postgres serializes JavaScript arrays as PostgreSQL arrays. JSONB array
 * columns must receive JSON text explicitly or [] may arrive as the JSON object {}.
 */
export function serializeAgentToolTrace(trace: AgentToolTraceEntry[]): string {
  return JSON.stringify(trace)
}

/**
 * Normalize persisted JSONB defensively. Feature 08.2 could write {} into
 * tool_trace before the explicit JSON serialization fix, so existing tenants must
 * remain readable without a destructive reset.
 */
export function normalizeAgentToolTrace(value: unknown): AgentToolTraceEntry[] {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isAgentToolTraceEntry)
}

function isAgentToolTraceEntry(value: unknown): value is AgentToolTraceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return Number.isInteger(entry.index)
    && typeof entry.name === 'string'
    && isPlainRecord(entry.arguments)
    && isPlainRecord(entry.result)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
