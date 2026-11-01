// Wall-clock times in the API's zone without a database round trip, for the mail and calendar routes:
// "2026-11-03 18:00" in TZ to an instant and back, through Temporal.
import { HttpError, tz } from './http.js';

const zoned = (d: Date, zone: string) => Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(zone);

/**
 * The instant of a wall-clock time in the zone: in a daylight saving gap the hour after, in the repeated hour the
 * second one. A date that doesn't exist (February 31, 25:00) is a RangeError.
 */
export function fromWall(y: number, mo: number, d: number, h = 0, mi = 0, zone = tz): Date {
  const t = Temporal.PlainDateTime.from({ year: y, month: mo, day: d, hour: h, minute: mi }, { overflow: 'reject' });
  return new Date(t.toZonedDateTime(zone, { disambiguation: 'later' }).epochMilliseconds);
}

/** "2026-11-03" in the zone. */
export const day = (d: Date, zone = tz) => zoned(d, zone).toPlainDate().toString();

/** "2026-11-03 18:00" in the zone. */
export const wall = (d: Date, zone = tz) => zoned(d, zone).toPlainDateTime().toString({ smallestUnit: 'minute' }).replace('T', ' ');

/** The wall-clock time in the zone as milliseconds (to the minute), for differences that ignore daylight saving. */
export const wallMs = (d: Date, zone = tz) => Date.parse(`${wall(d, zone).replace(' ', 'T')}:00Z`);

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Tue" for the day of that instant in the zone. */
export const weekday = (d: Date, zone = tz) => WEEKDAYS[zoned(d, zone).dayOfWeek - 1];

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

export type When = { at: Date; date: [number, number, number] | null };

/**
 * A date or date-time from a request; without an offset it's in the API's zone. `date` is set for a bare date
 * (its `at` is the start of that day), so a caller can treat it as a whole day.
 */
export function when(value: unknown, name: string): When {
  const s = typeof value === 'string' ? value.trim() : '';
  const m = WHEN.exec(s);
  if (!m) throw new HttpError(400, `${name} must look like 2026-11-03 or 2026-11-03 18:30 (${tz})`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  try {
    if (m[4] === undefined) return { at: fromWall(y, mo, d), date: [y, mo, d] };
    const at = m[7]
      ? new Date(Temporal.Instant.from(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7]}`).epochMilliseconds)
      : fromWall(y, mo, d, Number(m[4]), Number(m[5]));
    return { at, date: null };
  } catch (err) {
    // a date that doesn't exist, instead of the day it would roll over to
    if (err instanceof RangeError) throw new HttpError(400, `${name} is not a valid date: ${s}`);
    throw err;
  }
}

/** The start of the day after a date, in the zone. */
export function dayAfter([y, mo, d]: [number, number, number]): Date {
  const next = Temporal.PlainDate.from({ year: y, month: mo, day: d }).add({ days: 1 });
  return fromWall(next.year, next.month, next.day);
}
