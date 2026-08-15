import { EventValidationError } from '@ecc/domain'

interface LocalDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function scheduleRelativeToEvent(
  eventStartAt: Date,
  offsetDays: number,
  dueTime: string,
  timeZone: string,
): Date {
  return scheduleRelativeToReference(eventStartAt, offsetDays, dueTime, timeZone)
}

export function scheduleRelativeToReference(
  referenceAt: Date,
  offsetDays: number,
  dueTime: string,
  timeZone: string,
): Date {
  if (!Number.isInteger(offsetDays) || offsetDays < -3650 || offsetDays > 3650) {
    throw new EventValidationError('offsetDays must be an integer between -3650 and 3650')
  }

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dueTime)
  if (!match) throw new EventValidationError('dueTime must use HH:mm format')

  assertTimeZone(timeZone)
  const referenceLocal = partsInTimeZone(referenceAt, timeZone)
  const shifted = new Date(Date.UTC(referenceLocal.year, referenceLocal.month - 1, referenceLocal.day + offsetDays))
  const hour = Number(match[1])
  const minute = Number(match[2])

  return localDateTimeToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour,
      minute,
      second: 0,
    },
    timeZone,
  )
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch {
    throw new EventValidationError(`Invalid organization timezone: ${timeZone}`)
  }
}

function partsInTimeZone(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value
    if (!value) throw new EventValidationError(`Unable to resolve ${type} in timezone ${timeZone}`)
    return Number(value)
  }

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

function localDateTimeToUtc(target: LocalDateTimeParts, timeZone: string): Date {
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  )

  let candidate = targetAsUtc
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const represented = partsInTimeZone(new Date(candidate), timeZone)
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    )
    const delta = targetAsUtc - representedAsUtc
    candidate += delta
    if (delta === 0) break
  }

  const result = new Date(candidate)
  const check = partsInTimeZone(result, timeZone)
  const same =
    check.year === target.year &&
    check.month === target.month &&
    check.day === target.day &&
    check.hour === target.hour &&
    check.minute === target.minute

  if (!same) {
    throw new EventValidationError(
      `Local time ${formatTarget(target)} does not exist or is ambiguous in timezone ${timeZone}`,
    )
  }
  return result
}

function formatTarget(parts: LocalDateTimeParts): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}
