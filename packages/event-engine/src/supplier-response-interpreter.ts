import type { SupplierResponseInterpretation, SupplierResponseInterpreter } from '@ecc/domain'

export class RuleBasedSupplierResponseInterpreter implements SupplierResponseInterpreter {
  interpret(text: string): SupplierResponseInterpretation {
    const normalized = normalize(text)
    const arrivalTime = extractArrivalTime(normalized)
    const teamSize = extractTeamSize(normalized)

    if (matchesAny(normalized, [
      /\bn[aã]o (?:vou|vamos|podemos|poderemos|conseguimos|conseguiremos|participaremos|participar)\b/,
      /\binfelizmente\b.*\bn[aã]o\b/,
      /\bn[aã]o poderemos atender\b/,
      /\bindispon[ií]vel\b/,
    ])) {
      return { intent: 'decline', confidence: 0.98, arrivalTime: null, teamSize: null, reason: 'explicit_decline' }
    }

    if (matchesAny(normalized, [
      /\bainda n[aã]o (?:sei|consigo|podemos|posso)\b/,
      /\bte respondo\b/,
      /\bconfirmo (?:depois|amanh[aã])\b/,
      /\bpreciso (?:ver|confirmar)\b/,
    ])) {
      return { intent: 'undecided', confidence: 0.9, arrivalTime, teamSize, reason: 'explicit_undecided' }
    }

    if (matchesAny(normalized, [
      /\bsim\b/,
      /\bconfirmad[oa]s?\b/,
      /\bconfirmamos\b/,
      /\bestaremos\b/,
      /\biremos\b/,
    ])) {
      return { intent: 'confirm', confidence: 0.98, arrivalTime, teamSize, reason: 'explicit_confirmation' }
    }

    if (arrivalTime || teamSize !== null) {
      return { intent: 'confirm', confidence: 0.92, arrivalTime, teamSize, reason: 'operational_details_imply_confirmation' }
    }

    return { intent: 'unknown', confidence: 0.4, arrivalTime: null, teamSize: null, reason: 'no_supported_intent' }
  }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim()
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function extractArrivalTime(value: string): string | null {
  const patterns = [
    /\b(?:cheg(?:o|amos|aremos)|chegada(?: prevista)?|por volta d(?:as?|e)?|[aà]s?)\s*(?:de\s*)?([01]?\d|2[0-3])(?:\s*[:h]\s*([0-5]\d))?\s*(?:h(?:oras?)?)?\b/,
    /\b([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)\b/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    if (!match) continue
    const hour = Number(match[1])
    const minute = match[2] ? Number(match[2]) : 0
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }
  return null
}

function extractTeamSize(value: string): number | null {
  const patterns = [
    /\b(?:equipe\s+(?:de|com)|seremos|somos|ser[aã]o|vamos em)\s*(\d{1,3})\b/,
    /\b(\d{1,3})\s*(?:pessoas?|profissionais?|integrantes?|membros?)\b/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    if (!match) continue
    const size = Number(match[1])
    if (Number.isInteger(size) && size >= 1 && size <= 500) return size
  }
  return null
}
