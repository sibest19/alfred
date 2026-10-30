// iCloud Calendar over CalDAV: the events of a period, repeating ones expanded into their occurrences, and
// creating, changing and deleting events. Event ids are short (8 hex characters of the event's URL) and known from
// a listing or a write since the API started: an id from before a restart asks for the events to be listed again.
// Each answer carries `text`, the same as lines for a prompt, so an agent's tool can pass on that alone.
import { createHash, randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';
import { day, dayAfter, fromWall, wall, wallMs, weekday, when, type When } from './clock.js';
import { config } from './config.js';
import { HttpError, param, text, tz, type Query } from './http.js';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 366;
const MAX_TEXT = 500;
const NOTES_IN_LIST = 200;
// occurrences walked per repeating event, from its first one (a daily event from ten years ago is about 3650)
const MAX_STEPS = 20_000;
// calendars and the login, kept this long between requests
const DISCOVERY_TTL = 10 * 60_000;

type Client = Awaited<ReturnType<typeof createDAVClient>>;
let session: { client: Client; calendars: DAVCalendar[]; at: number } | undefined;

async function dav() {
  if (!config.icloud.user || !config.icloud.password) throw new HttpError(503, 'iCloud is not configured (ICLOUD_USER, ICLOUD_PASSWORD)');
  if (session && Date.now() - session.at < DISCOVERY_TTL) return session;
  try {
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com', authMethod: 'Basic', defaultAccountType: 'caldav',
      credentials: { username: config.icloud.user, password: config.icloud.password },
    });
    const calendars = (await client.fetchCalendars()).filter((c) => !c.components || c.components.includes('VEVENT'));
    session = { client, calendars, at: Date.now() };
    return session;
  } catch (err: any) {
    const message = String(err?.message ?? err);
    if (/401|unauthori[sz]ed|invalid credentials/i.test(message)) {
      throw new HttpError(502, 'iCloud refused the login: check ICLOUD_USER and the app-specific password');
    }
    throw new HttpError(502, `iCloud Calendar is unreachable: ${message}`);
  }
}

const baseName = (c: DAVCalendar) => (typeof c.displayName === 'string' && c.displayName.trim()) || c.url.split('/').filter(Boolean).pop()!;

/** The calendar's name, with " (2)", " (3)" after the first of several with the same name, so a name picks one. */
function calendarName(c: DAVCalendar): string {
  const same = (session?.calendars ?? [c]).filter((o) => baseName(o) === baseName(c));
  const n = same.findIndex((o) => o.url === c.url);
  return n > 0 ? `${baseName(c)} (${n + 1})` : baseName(c);
}

function pickCalendar(calendars: DAVCalendar[], name: string): DAVCalendar {
  const wanted = name || config.icloud.calendar;
  if (!wanted) return calendars[0];
  const found = calendars.find((c) => calendarName(c).toLowerCase() === wanted.toLowerCase());
  if (!found) throw new HttpError(400, `no calendar "${wanted}"; there are: ${calendars.map(calendarName).join(', ')}`);
  return found;
}

// --- event ids ---

const known = new Map<string, { url: string; calendar: string }>();

function idOf(url: string, calendar: DAVCalendar): string {
  const id = createHash('sha1').update(url).digest('hex').slice(0, 8);
  known.set(id, { url, calendar: calendar.url });
  return id;
}

async function objectOf(id: string): Promise<{ calendar: DAVCalendar; object: DAVCalendarObject; client: Client }> {
  const ref = known.get(id);
  if (!ref) throw new HttpError(404, `unknown event id "${id}": list the events again (GET /calendar/events) and use an id from there`);
  const { client, calendars } = await dav();
  const calendar = calendars.find((c) => c.url === ref.calendar);
  const [object] = calendar ? await client.fetchCalendarObjects({ calendar, objectUrls: [ref.url] }) : [];
  if (!calendar || !object?.data) throw new HttpError(404, `event ${id} no longer exists (deleted or moved): list the events again`);
  return { calendar, object, client };
}

// --- reading ---

function parse(ics: string) {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
  const vevents = root.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id')) ?? vevents[0];
  if (!master) return undefined;
  const event = new ICAL.Event(master);
  for (const v of vevents) if (v !== master && v.hasProperty('recurrence-id')) event.relateException(v);
  return { root, master, event };
}

type Occurrence = { start: ICAL.Time; end: ICAL.Time; item: ICAL.Event; recurrenceId: ICAL.Time | null };

/** The event's occurrences that overlap [from, to): one for a plain event, each one in the period for a repeating one. */
function occurrences(event: ICAL.Event, from: Date, to: Date): Occurrence[] {
  const overlaps = (s: ICAL.Time, e: ICAL.Time) => s.toJSDate() < to && (e.compare(s) > 0 ? e.toJSDate() > from : s.toJSDate() >= from);
  if (!event.isRecurring()) return overlaps(event.startDate, event.endDate) ? [{ start: event.startDate, end: event.endDate, item: event, recurrenceId: null }] : [];
  const found: Occurrence[] = [];
  const it = event.iterator();
  for (let next = it.next(), steps = 0; next && steps < MAX_STEPS; next = it.next(), steps++) {
    if (next.toJSDate() >= to) break;
    const d = event.getOccurrenceDetails(next);
    if (d.item.component.getFirstPropertyValue('status') === 'CANCELLED') continue;
    if (overlaps(d.startDate, d.endDate)) found.push({ start: d.startDate, end: d.endDate, item: d.item, recurrenceId: d.recurrenceId });
  }
  return found;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
// one line per event: a place or notes written over several lines become one
const oneLine = (v: unknown) => str(v).split(/\s*\n\s*/).filter(Boolean).join(', ').replace(/[ \t]+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function view(id: string, calendar: DAVCalendar, event: ICAL.Event, o: Pick<Occurrence, 'start' | 'end' | 'item'>, notesMax = NOTES_IN_LIST) {
  const allDay = o.start.isDate;
  const start = o.start.toJSDate();
  // an all-day event ends at the start of the day after its last day
  const end = allDay ? new Date(o.end.toJSDate().getTime() - 1) : o.end.toJSDate();
  const rrule = event.component.getFirstPropertyValue('rrule');
  return {
    id, calendar: calendarName(calendar), title: oneLine(o.item.summary),
    start: allDay ? day(start) : wall(start), end: allDay ? day(end) : wall(end), weekday: weekday(start), all_day: allDay,
    location: oneLine(o.item.location), notes: clip(oneLine(o.item.description), notesMax),
    repeats: rrule ? rrule.toString() : null,
  };
}

type View = ReturnType<typeof view>;

function line(e: View): string {
  let when: string;
  if (e.all_day) when = e.end === e.start ? `${e.weekday} ${e.start} (all day)` : `${e.weekday} ${e.start} – ${e.end} (all day)`;
  else when = `${e.weekday} ${e.start}–${e.end.slice(0, 10) === e.start.slice(0, 10) ? e.end.slice(11) : e.end}`;
  return [`[${e.id}] ${when} | ${e.title}`, e.location && `@ ${e.location}`, e.calendar, e.repeats && `repeats ${e.repeats}`, e.notes && `notes: ${e.notes}`]
    .filter(Boolean).join(' | ');
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** GET /calendar/events: the events of a period (from, to; a week from today by default), by words and calendar. */
export async function listEvents(q: Query) {
  const fromW = param(q, 'from') === undefined ? undefined : when(param(q, 'from'), 'from');
  const toW = param(q, 'to') === undefined ? undefined : when(param(q, 'to'), 'to');
  const today = day(new Date()).split('-').map(Number);
  const from = fromW?.at ?? fromWall(today[0], today[1], today[2]);
  const to = toW ? (toW.date ? dayAfter(toW.date) : toW.at) : new Date(from.getTime() + DEFAULT_DAYS * 86_400_000);
  if (to <= from) throw new HttpError(400, '"to" must be after "from"');
  if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw new HttpError(400, `at most ${MAX_DAYS} days at a time`);
  const words = fold(param(q, 'q') ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];

  const { client, calendars } = await dav();
  const only = param(q, 'calendar');
  const chosen = only ? [pickCalendar(calendars, only)] : calendars;
  const events: View[] = [];
  await Promise.all(chosen.map(async (calendar) => {
    const objects = await client.fetchCalendarObjects({ calendar, timeRange: { start: from.toISOString(), end: to.toISOString() } });
    for (const object of objects) {
      const parsed = object.data && parse(object.data);
      if (!parsed) continue;
      const id = idOf(object.url, calendar);
      for (const o of occurrences(parsed.event, from, to)) {
        const e = view(id, calendar, parsed.event, o);
        const haystack = fold(`${e.title} ${e.location} ${e.notes}`);
        if (words.every((w) => haystack.includes(w))) events.push(e);
      }
    }
  }));
  events.sort((a, b) => a.start.localeCompare(b.start) || Number(b.all_day) - Number(a.all_day));
  const period = `${weekday(from)} ${wall(from)} – ${weekday(to)} ${wall(to)} (${tz})`;
  const lines = events.length ? events.map(line) : [`No events ${words.length ? 'matching the search ' : ''}in ${period}.`];
  lines.push(`Calendars: ${calendars.map(calendarName).join(', ')}`);
  return { from: wall(from), to: wall(to), events, text: lines.join('\n') };
}

// --- writing ---

/** A start or end as an iCalendar time: a whole day, or an instant written in `zone` (UTC when none). */
function icalTime(w: When, allDay: boolean, zone?: ICAL.Timezone): ICAL.Time {
  if (allDay) {
    const [year, month, d] = w.date ?? day(w.at).split('-').map(Number);
    return ICAL.Time.fromData({ year, month, day: d, isDate: true });
  }
  const t = ICAL.Time.fromJSDate(w.at, true);
  return zone && zone !== ICAL.Timezone.utcTimezone && zone !== ICAL.Timezone.localTimezone ? t.convertToZone(zone) : t;
}

type Fields = { title?: string; start?: When; end?: When; allDay?: boolean; location?: string; notes?: string };

function fields(body: Record<string, unknown>, creating: boolean): Fields {
  const f: Fields = {};
  const has = (k: string) => body[k] !== undefined && text(body[k]) !== '';
  if (has('title')) f.title = text(body.title);
  else if (creating) throw new HttpError(400, 'title is required');
  if (f.title && f.title.length > MAX_TEXT) throw new HttpError(400, `title: at most ${MAX_TEXT} characters`);
  if (has('start')) f.start = when(body.start, 'start');
  else if (creating) throw new HttpError(400, `start is required: 2026-11-03 18:00, or 2026-11-03 for an all-day event (${tz})`);
  if (has('end')) f.end = when(body.end, 'end');
  if (has('all_day')) f.allDay = ['true', '1', 'yes'].includes(text(body.all_day).toLowerCase());
  // empty is kept (a tool sends every field, filled or not); "-" removes a place or notes
  for (const [key, field] of [['location', 'location'], ['notes', 'notes']] as const) {
    if (has(key)) f[field] = text(body[key]) === '-' ? '' : text(body[key]);
  }
  return f;
}

/** Applies the fields to a VEVENT: a new start keeps the duration unless an end is given; a bare date makes it all-day. */
function apply(event: ICAL.Event, f: Fields) {
  const oldStart = event.startDate;
  const allDay = f.allDay ?? (f.start ? f.start.date !== null : oldStart?.isDate ?? false);
  const zone = oldStart && !oldStart.isDate ? oldStart.zone : undefined;
  if (f.title !== undefined) event.summary = f.title;
  if (f.start) {
    const duration = oldStart ? event.duration : undefined;
    event.startDate = icalTime(f.start, allDay, zone);
    if (!f.end) {
      const end = event.startDate.clone();
      if (duration && oldStart.isDate === allDay) end.addDuration(duration);
      else if (allDay) end.adjust(1, 0, 0, 0);
      else end.adjust(0, 1, 0, 0);
      event.endDate = end;
    }
  }
  if (f.end) {
    // an all-day end names the last day; iCalendar wants the day after
    const end = icalTime(f.end, allDay, zone);
    if (allDay) end.adjust(1, 0, 0, 0);
    event.endDate = end;
  }
  if (event.endDate.compare(event.startDate) <= 0) throw new HttpError(400, 'the end must be after the start');
  for (const [name, value] of [['location', f.location], ['description', f.notes]] as const) {
    if (value === undefined) continue;
    if (value) event.component.updatePropertyWithValue(name, value);
    else event.component.removeAllProperties(name);
  }
  const now = ICAL.Time.fromJSDate(new Date(), true);
  event.component.updatePropertyWithValue('dtstamp', now);
  event.component.updatePropertyWithValue('last-modified', now);
}

function check(res: Response, what: string) {
  if (res.status === 412) throw new HttpError(409, `the event changed in iCloud meanwhile: list the events again, then ${what}`);
  if (!res.ok) throw new HttpError(502, `iCloud refused to ${what} (HTTP ${res.status})`);
}

function written(id: string, calendar: DAVCalendar, ics: string, verb: string, target?: Date) {
  const parsed = parse(ics)!;
  const [o] = target ? occurrences(parsed.event, target, new Date(target.getTime() + 1)) : [];
  const e = view(id, calendar, parsed.event, o ?? { start: parsed.event.startDate, end: parsed.event.endDate, item: parsed.event }, MAX_TEXT);
  return { event: e, text: `${verb}: ${line(e)}` };
}

const truthy = (v: unknown) => ['true', '1', 'yes'].includes(text(v).toLowerCase());

/** The occurrence of a repeating event on a date (a moved one by its new date). */
function occurrenceOn(event: ICAL.Event, value: string, verb: string): Occurrence & { recurrenceId: ICAL.Time } {
  if (!value) {
    throw new HttpError(400, `"${event.summary}" repeats: give occurrence, the date of the one you mean, and series=true to ${verb} every occurrence`);
  }
  const w = when(value, 'occurrence');
  if (!w.date) throw new HttpError(400, 'occurrence is a date: 2026-11-03');
  const [o] = occurrences(event, w.at, dayAfter(w.date));
  if (!o?.recurrenceId) throw new HttpError(404, `"${event.summary}" has no occurrence on ${value}`);
  return o as Occurrence & { recurrenceId: ICAL.Time };
}

/** The VEVENT that overrides one occurrence: the existing one, or a copy of the series' fields for it. */
function exceptionFor(parsed: NonNullable<ReturnType<typeof parse>>, o: Occurrence & { recurrenceId: ICAL.Time }): ICAL.Component {
  for (const v of parsed.root.getAllSubcomponents('vevent')) {
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (rid instanceof ICAL.Time && rid.compare(o.recurrenceId) === 0) return v;
  }
  const v = new ICAL.Component('vevent');
  for (const p of parsed.master.getAllProperties()) {
    if (!['rrule', 'rdate', 'exdate', 'dtstart', 'dtend', 'duration'].includes(p.name)) v.addProperty(ICAL.Property.fromString(p.toICALString()));
  }
  const rid = v.addPropertyWithValue('recurrence-id', o.recurrenceId.clone());
  const tzid = o.recurrenceId.zone?.tzid;
  if (!o.recurrenceId.isDate && tzid && tzid !== 'UTC' && tzid !== 'floating') rid.setParameter('tzid', tzid);
  const event = new ICAL.Event(v);
  event.startDate = o.start.clone();
  event.endDate = o.end.clone();
  parsed.root.addSubcomponent(v);
  return v;
}

/** Moves a time by a wall-clock difference (whole days for a date), so 18:00 stays 18:30 on both sides of a DST change. */
function shifted(t: ICAL.Time, ms: number): ICAL.Time {
  const c = t.clone();
  if (c.isDate) c.adjust(Math.round(ms / 86_400_000), 0, 0, 0);
  else c.adjust(0, 0, 0, ms / 1000);
  return c;
}

/** A change to every occurrence, from the one named: a new start moves the series (and its exceptions) by as much. */
function changeSeries(parsed: NonNullable<ReturnType<typeof parse>>, o: Occurrence, f: Fields) {
  const allDay = o.start.isDate;
  if ((f.allDay !== undefined && f.allDay !== allDay) || (f.start && (f.start.date !== null) !== allDay)) {
    throw new HttpError(400, 'a repeating series stays all-day or timed: change one occurrence instead, or delete the series and create it again');
  }
  const event = parsed.event;
  const duration = event.duration;
  const occStart = f.start?.at ?? o.start.toJSDate();
  if (f.start) {
    const delta = wallMs(f.start.at) - wallMs(o.start.toJSDate());
    event.startDate = shifted(event.startDate, delta);
    for (const v of parsed.root.getAllSubcomponents('vevent')) {
      const rid = v.getFirstProperty('recurrence-id');
      if (rid) rid.setValue(shifted(rid.getFirstValue() as ICAL.Time, delta));
    }
    for (const ex of parsed.master.getAllProperties('exdate')) ex.setValues(ex.getValues().map((t: ICAL.Time) => shifted(t, delta)));
  }
  const end = event.startDate.clone();
  if (f.end) {
    const endAt = allDay ? dayAfter(f.end.date ?? (day(f.end.at).split('-').map(Number) as [number, number, number])) : f.end.at;
    const length = (endAt.getTime() - occStart.getTime()) / 1000;
    if (length <= 0) throw new HttpError(400, 'the end must be after the start');
    end.addDuration(ICAL.Duration.fromSeconds(length));
  } else end.addDuration(duration);
  event.endDate = end;
  apply(event, { title: f.title, location: f.location, notes: f.notes });
}

const bumpSequence = (v: ICAL.Component) => v.updatePropertyWithValue('sequence', Number(v.getFirstPropertyValue('sequence') ?? 0) + 1);

/** POST /calendar/events: title, start, end (an hour later, or the same day), all_day, location, notes, calendar. */
export async function createEvent(body: Record<string, unknown>) {
  const f = fields(body, true);
  const { client, calendars } = await dav();
  const calendar = pickCalendar(calendars, text(body.calendar));
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('prodid', '-//alfred//api//EN');
  root.updatePropertyWithValue('version', '2.0');
  const vevent = new ICAL.Component('vevent');
  root.addSubcomponent(vevent);
  const event = new ICAL.Event(vevent);
  event.uid = randomUUID().toUpperCase();
  apply(event, f);
  const filename = `${event.uid}.ics`;
  const ics = root.toString();
  check(await client.createCalendarObject({ calendar, filename, iCalString: ics }), 'create the event');
  return written(idOf(new URL(filename, calendar.url).href, calendar), calendar, ics, 'Created');
}

/**
 * PATCH /calendar/events/<id>: the fields to change. On a repeating event `occurrence` (a date) names the one meant:
 * only that one changes, or with series=true all of them (a new start moves every occurrence by as much).
 */
export async function updateEvent(id: string, body: Record<string, unknown>) {
  const f = fields(body, false);
  if (!Object.keys(f).length) throw new HttpError(400, 'nothing to change: give title, start, end, all_day, location or notes');
  const { calendar, object, client } = await objectOf(id);
  const parsed = parse(object.data)!;
  let target: Date;
  if (!parsed.event.isRecurring()) {
    apply(parsed.event, f);
    target = parsed.event.startDate.toJSDate();
  } else {
    const o = occurrenceOn(parsed.event, text(body.occurrence), 'change');
    if (truthy(body.series)) {
      changeSeries(parsed, o, f);
      target = f.start?.at ?? o.start.toJSDate();
    } else {
      const exception = new ICAL.Event(exceptionFor(parsed, o));
      apply(exception, f);
      bumpSequence(exception.component);
      target = exception.startDate.toJSDate();
    }
  }
  bumpSequence(parsed.master);
  const ics = parsed.root.toString();
  check(await client.updateCalendarObject({ calendarObject: { url: object.url, etag: object.etag, data: ics } }), 'change the event');
  return written(id, calendar, ics, 'Changed', target);
}

/** DELETE /calendar/events/<id>: the event (a whole series), or with `occurrence` (a date) that one occurrence only. */
export async function deleteEvent(id: string, q: Query) {
  const { calendar, object, client } = await objectOf(id);
  const parsed = parse(object.data)!;
  const occurrence = param(q, 'occurrence');
  if (!occurrence) {
    check(await client.deleteCalendarObject({ calendarObject: { url: object.url, etag: object.etag } }), 'delete the event');
    known.delete(id);
    return { deleted: id, text: `Deleted: ${parsed.event.summary}${parsed.event.isRecurring() ? ' (the whole series)' : ''}` };
  }
  if (!parsed.event.isRecurring()) throw new HttpError(400, 'occurrence only goes with a repeating event; leave it out to delete this one');
  const o = occurrenceOn(parsed.event, occurrence, 'delete');
  // the occurrence goes into EXDATE, in the start's own zone, and a changed copy of it (an exception) goes too
  const exdate = parsed.master.addPropertyWithValue('exdate', o.recurrenceId.clone());
  const tzid = parsed.event.startDate.zone?.tzid;
  if (!o.recurrenceId.isDate && tzid && tzid !== 'UTC' && tzid !== 'floating') exdate.setParameter('tzid', tzid);
  for (const v of parsed.root.getAllSubcomponents('vevent')) {
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (rid instanceof ICAL.Time && rid.compare(o.recurrenceId) === 0) parsed.root.removeSubcomponent(v);
  }
  bumpSequence(parsed.master);
  check(await client.updateCalendarObject({ calendarObject: { url: object.url, etag: object.etag, data: parsed.root.toString() } }), 'delete the occurrence');
  const start = o.start.toJSDate();
  return { deleted: id, occurrence: day(start), text: `Deleted the occurrence of ${weekday(start)} ${o.start.isDate ? day(start) : wall(start)} of "${o.item.summary}"; the rest of the series stays` };
}
