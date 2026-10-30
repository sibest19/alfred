// Wall-clock times in the API's zone without a database round trip, for the mail and calendar routes:
// "2026-11-03 18:00" in TZ to an instant and back.
import { HttpError, tz } from './http.js';

function parts(d: Date, zone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return Object.fromEntries(fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

/** The zone's offset from UTC at that instant, in milliseconds. */
function offset(d: Date, zone: string): number {
  const p = parts(d, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}

/** The instant of a wall-clock time in the zone (in a daylight saving gap, the hour after). */
export function fromWall(y: number, mo: number, d: number, h = 0, mi = 0, zone = tz): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offset(new Date(guess), zone);
  return new Date(guess - offset(new Date(first), zone));
}

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-11-03" in the zone. */
export function day(d: Date, zone = tz): string {
  const p = parts(d, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "2026-11-03 18:00" in the zone. */
export function wall(d: Date, zone = tz): string {
  const p = parts(d, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** The wall-clock time in the zone as milliseconds (to the minute), for differences that ignore daylight saving. */
export const wallMs = (d: Date, zone = tz) => Date.parse(`${wall(d, zone).replace(' ', 'T')}:00Z`);

/** "Tue" for the day of that instant in the zone. */
export function weekday(d: Date, zone = tz): string {
  const p = parts(d, zone);
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
}

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
  if (m[4] === undefined) return { at: fromWall(y, mo, d), date: [y, mo, d] };
  const at = m[7] ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7]}`) : fromWall(y, mo, d, Number(m[4]), Number(m[5]));
  if (Number.isNaN(at.getTime())) throw new HttpError(400, `${name} is not a valid time: ${s}`);
  return { at, date: null };
}

/** The start of the day after a bare date, in the zone. */
export const dayAfter = ([y, mo, d]: [number, number, number]) => fromWall(y, mo, d + 1);
