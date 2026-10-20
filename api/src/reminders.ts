// Reminders: an assistant's alarms. A scheduler calls POST /reminders/due every minute, which claims the due
// reminders (marks them fired) and returns them for sending. A repeating reminder is one row per occurrence: the
// claim inserts the next occurrence and moves the repeat to it, so snoozing a fired one never shifts the series.
import { sql } from '@alfred/db';
import { and, HttpError, intParam, like, oneOf, param, text, timeBound, tz, type Query } from './http.js';

const STATUSES = ['pending', 'fired', 'done', 'cancelled'] as const;
const UNITS = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month', year: 'year', yearly: 'year' } as const;
const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const MAX_TEXT = 500;
const LATE_MINUTES = 5;
const DUE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const columns = sql`
  id::int AS id, text, to_char(due_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS due,
  to_char(due_at AT TIME ZONE ${tz}, 'Dy') AS weekday, status,
  repeat_unit, repeat_every, repeat_days, to_char((repeat_until - interval '1 second') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS repeat_until,
  coalesce(series_id, id)::int AS series, source,
  to_char(fired_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS fired, to_char(done_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS done`;

type Row = Record<string, any>;

/** The row as the API shows it: the repeat as one readable field instead of four columns. */
function view(r: Row): Row {
  const { repeat_unit: unit, repeat_every: every, repeat_days: days, repeat_until: until, ...rest } = r;
  let repeat: string | null = null;
  if (unit) {
    repeat = every > 1 ? `every ${every} ${unit}s` : `every ${unit}`;
    if (unit === 'week' && days?.length) repeat += ` on ${days.map((d: number) => WEEKDAYS[d - 1]).join(', ')}`;
    if (until) repeat += ` until ${until}`;
  }
  return { ...rest, repeat };
}

/** A due time: "2026-10-23 15:00" (local) or with an offset; a bare date means 09:00. Must not be in the past. */
async function dueTime(v: unknown, name = 'due'): Promise<Date> {
  let s = text(v).replace('T', ' ');
  if (!DUE.test(s)) throw new HttpError(400, `${name} must look like 2026-10-23 15:00 (${tz})`);
  if (s.length === 10) s += ' 09:00';
  const local = !/(Z|[+-]\d{2}:?\d{2})$/.test(s);
  const [{ t, past, now }] = await sql`
    SELECT t, t < now() - interval '1 minute' AS past, to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS now
    FROM (SELECT ${local ? sql`${s}::text::timestamp AT TIME ZONE ${tz}` : sql`${s}::text::timestamptz`} AS t) x`;
  if (past) throw new HttpError(400, `${name} ${s} is in the past (now: ${now} ${tz})`);
  return t;
}

type Repeat = { unit: string; every: number; days: number[] | null; until: Date | null } | null;

/** The repeat fields of a request: repeat (day/week/month/year or "none"), every, days (weekly: mo,th or 1,4), until. */
async function repeatOf(body: Row): Promise<Repeat | undefined> {
  const raw = text(body.repeat).toLowerCase();
  if (!raw) return undefined;
  if (raw === 'none' || raw === 'no' || raw === 'never') return null;
  const unit = UNITS[raw as keyof typeof UNITS];
  if (!unit) throw new HttpError(400, 'repeat must be one of: day, week, month, year, none');
  const every = body.every === undefined || text(body.every) === '' ? 1 : Number(text(body.every));
  if (!Number.isInteger(every) || every < 1 || every > 366) throw new HttpError(400, 'every must be a whole number from 1 to 366');
  let days: number[] | null = null;
  const rawDays = Array.isArray(body.days) ? body.days.map(text) : text(body.days).split(',');
  const list = rawDays.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (list.length) {
    if (unit !== 'week') throw new HttpError(400, 'days only go with repeat=week');
    days = [...new Set(list.map((d) => (/^[1-7]$/.test(d) ? Number(d) : WEEKDAYS.indexOf(d.slice(0, 2)) + 1)))].sort();
    if (days.some((d) => d < 1)) throw new HttpError(400, `days must be weekdays: ${WEEKDAYS.join(', ')}`);
  }
  const untilRaw = text(body.until);
  let until: Date | null = null;
  if (untilRaw) {
    const end = timeBound(untilRaw, 'until', true)!;
    [{ until }] = await sql`SELECT ${end} AS until`;
  }
  return { unit, every, days, until };
}

const fields = (r: NonNullable<Repeat>, anchor: Date) => sql`
  repeat_unit = ${r.unit}, repeat_every = ${r.every}, repeat_days = ${r.days}::int[], repeat_until = ${r.until},
  repeat_anchor = (${anchor}::timestamptz AT TIME ZONE ${tz})`;

/** For a weekly repeat on given days, the first matching occurrence at or after `due` (at the same time of day). */
async function firstOccurrence(due: Date, r: Repeat): Promise<Date> {
  if (!r?.days?.length) return due;
  const [{ first }] = await sql`
    SELECT CASE WHEN extract(isodow FROM ${due}::timestamptz AT TIME ZONE ${tz})::int = ANY (${r.days}::int[]) THEN ${due}::timestamptz
      ELSE reminder_next(${due}::timestamptz AT TIME ZONE ${tz}, 'week', ${r.every}, ${r.days}::int[], ${r.until}, ${due}::timestamptz, ${tz}) END AS first`;
  return first ?? due;
}

export async function createReminder(body: Row) {
  const t = text(body.text);
  if (!t) throw new HttpError(400, 'text is required');
  if (t.length > MAX_TEXT) throw new HttpError(400, `text is longer than ${MAX_TEXT} characters`);
  const source = oneOf(text(body.source) || 'user', ['user', 'assistant'] as const, 'source')!;
  const repeat = await repeatOf(body);
  const due = await firstOccurrence(await dueTime(body.due), repeat ?? null);
  const [r] = await sql`
    INSERT INTO reminders (text, due_at, source, repeat_unit, repeat_every, repeat_days, repeat_until, repeat_anchor)
    VALUES (${t}, ${due}, ${source}, ${repeat?.unit ?? null}, ${repeat?.every ?? 1}, ${repeat?.days ?? null}::int[], ${repeat?.until ?? null},
            ${repeat ? sql`${due}::timestamptz AT TIME ZONE ${tz}` : null})
    RETURNING ${columns}`;
  return view(r);
}

export async function listReminders(q: Query) {
  const status = param(q, 'status') ?? 'open';
  const statuses =
    status === 'all' ? [...STATUSES] : status === 'open' ? ['pending', 'fired'] : [oneOf(status, STATUSES, 'status')!];
  const words = param(q, 'q');
  const from = timeBound(param(q, 'from'), 'from', false);
  const to = timeBound(param(q, 'to'), 'to', true);
  const rows = await sql`
    SELECT ${columns} FROM reminders
    WHERE ${and([
      sql`status = ANY (${statuses})`,
      // fired ones stay "open" for a day, until done or snoozed
      status === 'open' ? sql`(status = 'pending' OR fired_at > now() - interval '1 day')` : undefined,
      words ? sql`text ILIKE ${like(words)}` : undefined,
      from && sql`due_at >= ${from}`,
      to && sql`due_at < ${to}`,
    ])}
    ORDER BY due_at LIMIT ${intParam(q, 'limit', 50, 200)}`;
  return { count: rows.length, now: await nowLocal(), reminders: rows.map(view) };
}

const nowLocal = async () => (await sql`SELECT to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI Dy') AS n`)[0].n as string;

async function openReminder(id: string): Promise<Row> {
  const [r] = await sql`SELECT *, coalesce(series_id, id) AS root FROM reminders WHERE id = ${id}::bigint`;
  if (!r) throw new HttpError(404, `no reminder ${id}`);
  if (r.status !== 'pending' && r.status !== 'fired') throw new HttpError(409, `reminder ${id} is already ${r.status}`);
  return r;
}

/**
 * Changes text, time or repeat. On a repeating reminder a new due moves the whole series to that time
 * (snooze moves only this occurrence); repeat=none ends the series after this occurrence.
 */
export async function updateReminder(id: string, body: Row) {
  const r = await openReminder(id);
  const t = text(body.text) || null;
  if (t && t.length > MAX_TEXT) throw new HttpError(400, `text is longer than ${MAX_TEXT} characters`);
  // undefined: keep the repeat, null: stop repeating, else the new repeat
  const repeat = await repeatOf(body);
  if (repeat && r.status === 'fired') throw new HttpError(409, 'this occurrence already fired: set the repeat on the next one');
  const current: Repeat = r.repeat_unit
    ? { unit: r.repeat_unit, every: r.repeat_every, days: r.repeat_days, until: r.repeat_until }
    : null;
  const next = repeat === undefined ? current : repeat;
  let due = text(body.due) ? await dueTime(body.due) : null;
  if (due && next) due = await firstOccurrence(due, next);
  const repeatSet =
    repeat === null ? sql`, repeat_unit = NULL, repeat_anchor = NULL, repeat_days = NULL, repeat_until = NULL`
    : next && (repeat || due) ? sql`, ${fields(next, due ?? r.due_at)}`
    : sql``;
  const dueSet = due ? sql`, due_at = ${due}, status = 'pending', fired_at = NULL` : sql``;
  const [row] = await sql`
    UPDATE reminders SET text = coalesce(${t}, text), updated_at = now() ${dueSet} ${repeatSet}
    WHERE id = ${id}::bigint RETURNING ${columns}`;
  return view(row);
}

/** Moves this occurrence only: by `minutes`, or to `until` (a time like `due`). A fired reminder becomes pending again. */
export async function snoozeReminder(id: string, body: Row) {
  await openReminder(id);
  let due: Date;
  if (text(body.until)) due = await dueTime(body.until, 'until');
  else {
    const minutes = Number(text(body.minutes) || '60');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 * 24 * 366) throw new HttpError(400, 'minutes must be a whole number of minutes');
    [{ due }] = await sql`SELECT now() + make_interval(mins => ${minutes}) AS due`;
  }
  const [row] = await sql`
    UPDATE reminders SET due_at = ${due}, status = 'pending', fired_at = NULL, updated_at = now()
    WHERE id = ${id}::bigint RETURNING ${columns}`;
  return view(row);
}

/** Marks a reminder done. On a pending repeating one this skips the occurrence: the next one is scheduled. */
export async function doneReminder(id: string) {
  return sql.begin(async (t) => {
    const tx = t as unknown as typeof sql;
    const [r] = await tx`SELECT * FROM reminders WHERE id = ${id}::bigint FOR UPDATE`;
    if (!r) throw new HttpError(404, `no reminder ${id}`);
    if (r.status === 'done') return { done: view((await tx`SELECT ${columns} FROM reminders WHERE id = ${id}::bigint`)[0]), next: null };
    if (r.status === 'cancelled') throw new HttpError(409, `reminder ${id} was cancelled`);
    const next = r.status === 'pending' && r.repeat_unit ? await scheduleNext(tx, r) : null;
    const [row] = await tx`
      UPDATE reminders SET status = 'done', done_at = now(), repeat_unit = NULL, repeat_anchor = NULL, repeat_days = NULL,
        repeat_until = NULL, updated_at = now()
      WHERE id = ${id}::bigint RETURNING ${columns}`;
    return { done: view(row), next };
  });
}

/** Cancels a reminder and, for a repeating one, the rest of its series. */
export async function cancelReminder(id: string) {
  const r = await openReminder(id);
  const rows = await sql`
    UPDATE reminders SET status = 'cancelled', updated_at = now()
    WHERE (id = ${id}::bigint OR (coalesce(series_id, id) = ${r.root} AND status = 'pending'))
    RETURNING id::int AS id, text, to_char(due_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS due`;
  return { cancelled: rows };
}

/** Inserts the occurrence after `r` (from now on, so missed ones are skipped); null when the repeat has ended. */
async function scheduleNext(tx: typeof sql, r: Row) {
  // all in SQL: repeat_anchor is a timestamp without zone, which a round trip through a JS Date would shift
  const [n] = await tx`
    INSERT INTO reminders (text, due_at, source, repeat_unit, repeat_every, repeat_days, repeat_until, repeat_anchor, series_id)
    SELECT text, nxt, source, repeat_unit, repeat_every, repeat_days, repeat_until, repeat_anchor, coalesce(series_id, id)
    FROM (SELECT *, reminder_next(repeat_anchor, repeat_unit, repeat_every, repeat_days, repeat_until, greatest(now(), due_at), ${tz}) AS nxt
          FROM reminders WHERE id = ${r.id}) x
    WHERE nxt IS NOT NULL
    RETURNING ${columns}`;
  return n ? view(n) : null;
}

/**
 * For the scheduler: claims every pending reminder that is due (marks it fired) and returns them, oldest first.
 * Concurrent calls never return the same reminder. `late` marks the ones more than a few minutes overdue
 * (the server was down); `next` is the following occurrence of a repeating one.
 */
export async function claimDue() {
  return sql.begin(async (t) => {
    const tx = t as unknown as typeof sql;
    const due = await tx`
      SELECT * FROM reminders WHERE status = 'pending' AND due_at <= now() ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED`;
    const out = [];
    for (const r of due) {
      const next = r.repeat_unit ? await scheduleNext(tx, r) : null;
      const [row] = await tx`
        UPDATE reminders SET status = 'fired', fired_at = now(), repeat_unit = NULL, repeat_anchor = NULL, repeat_days = NULL,
          repeat_until = NULL, updated_at = now()
        WHERE id = ${r.id} RETURNING ${columns}, now() - due_at > make_interval(mins => ${LATE_MINUTES}) AS late`;
      out.push({ ...view(row), next: next && { id: next.id, due: next.due, repeat: next.repeat } });
    }
    return { count: out.length, reminders: out };
  });
}
