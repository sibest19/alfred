// To-dos (VTODO) in Radicale's lists: the reminders a phone's Reminders app shows and rings for. A due time is written
// in TZ with an alarm at that moment, the format the iPhone rings for; phones see changes at their next fetch, there is
// no push. Ids are short (8 hex characters of the item's URL) and known from a listing or a write since the API
// started. Writes send the item's ETag, so a change made on a phone meanwhile is never overwritten.
import { createHash, randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import type { DAVCalendar } from 'tsdav';
import { day, fromWall, wall, weekday, when } from './clock.js';
import { HttpError, param, text, tz, type Query } from './http.js';
import { radicale, type Dav } from './radicale.js';

const MAX_TEXT = 500;
const MAX_LISTED = 200;
const VTODO_FILTER = [{ 'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VTODO' } } } }];

const listName = (c: DAVCalendar) => (typeof c.displayName === 'string' && c.displayName.trim()) || c.url.split('/').filter(Boolean).pop()!;

async function lists(): Promise<{ client: Dav; lists: DAVCalendar[] }> {
  const { client, calendars } = await radicale();
  const found = calendars.filter((c) => c.components?.includes('VTODO'));
  if (!found.length) throw new HttpError(503, 'Radicale has no to-do list under RADICALE_HOME');
  return { client, lists: found };
}

function pickList(all: DAVCalendar[], name: string): DAVCalendar {
  if (!name) return all[0];
  const found = all.find((c) => listName(c).toLowerCase() === name.toLowerCase());
  if (!found) throw new HttpError(400, `no list "${name}"; there are: ${all.map(listName).join(', ')}`);
  return found;
}

const known = new Map<string, { url: string; list: string }>();

function idOf(url: string, list: DAVCalendar): string {
  const id = createHash('sha1').update(url).digest('hex').slice(0, 8);
  known.set(id, { url, list: list.url });
  return id;
}

async function objectOf(id: string) {
  const ref = known.get(id);
  if (!ref) throw new HttpError(404, `unknown reminder id "${id}": list the reminders again (GET /todos) and use an id from there`);
  const { client, lists: all } = await lists();
  const list = all.find((c) => c.url === ref.list);
  const [object] = list ? await client.fetchCalendarObjects({ calendar: list, objectUrls: [ref.url], filters: VTODO_FILTER }) : [];
  if (!list || !object?.data) throw new HttpError(404, `reminder ${id} no longer exists (deleted on a phone?): list the reminders again`);
  return { client, list, object };
}

// --- iCalendar ---

/** A time as the wall clock of TZ: a floating time or one in TZ (with no VTIMEZONE: floating) is that already. */
function wallOf(t: ICAL.Time): { at: Date; shown: string; isDate: boolean } {
  if (t.isDate) return { at: fromWall(t.year, t.month, t.day), shown: day(fromWall(t.year, t.month, t.day)), isDate: true };
  const at = t.zone?.tzid === 'floating' || t.zone?.tzid === tz ? fromWall(t.year, t.month, t.day, t.hour, t.minute) : t.toJSDate();
  return { at, shown: wall(at), isDate: false };
}

/** A wall-clock time of TZ as an iCalendar property value, written with TZID like the phones expect. */
function setTime(vtodo: ICAL.Component, name: 'dtstart' | 'due', at: Date) {
  const [d, hm] = wall(at).split(' ');
  const [year, month, dd] = d.split('-').map(Number);
  const [hour, minute] = hm.split(':').map(Number);
  const prop = vtodo.updatePropertyWithValue(name, ICAL.Time.fromData({ year, month, day: dd, hour, minute }));
  prop.setParameter('tzid', tz);
}

/** A display alarm at the due time, the kind the phones ring for. */
function addAlarm(vtodo: ICAL.Component) {
  const alarm = new ICAL.Component('valarm');
  alarm.addPropertyWithValue('action', 'DISPLAY');
  alarm.addPropertyWithValue('description', String(vtodo.getFirstPropertyValue('summary') ?? 'Reminder'));
  alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(0));
  vtodo.addSubcomponent(alarm);
}

/** Moves alarms set at a fixed time by `ms` (relative ones follow DTSTART or DUE) and clears the phone's "rang" mark. */
function shiftAlarms(vtodo: ICAL.Component, ms: number) {
  for (const alarm of vtodo.getAllSubcomponents('valarm')) {
    alarm.removeAllProperties('acknowledged');
    const trigger = alarm.getFirstProperty('trigger');
    const value = trigger?.getFirstValue();
    if (value instanceof ICAL.Time) trigger!.setValue(ICAL.Time.fromJSDate(new Date(value.toJSDate().getTime() + ms), true));
  }
}

/**
 * A new due time, written in TZ: DTSTART moves with it at the same distance (the iPhone writes both, and a relative
 * alarm counts from one of them), the item's alarms move along, and one at the due time is added when it has none.
 * Without a time the dates and the alarms go.
 */
export function setDue(vtodo: ICAL.Component, at: Date | null) {
  const oldDue = vtodo.getFirstPropertyValue('due') as ICAL.Time | null;
  const oldStart = vtodo.getFirstPropertyValue('dtstart') as ICAL.Time | null;
  if (!at) {
    for (const name of ['due', 'dtstart']) vtodo.removeAllProperties(name);
    for (const alarm of vtodo.getAllSubcomponents('valarm')) vtodo.removeSubcomponent(alarm);
    return;
  }
  const lead = oldDue && oldStart ? wallOf(oldDue).at.getTime() - wallOf(oldStart).at.getTime() : 0;
  setTime(vtodo, 'due', at);
  setTime(vtodo, 'dtstart', new Date(at.getTime() - lead));
  if (oldDue) shiftAlarms(vtodo, at.getTime() - wallOf(oldDue).at.getTime());
  if (!vtodo.getAllSubcomponents('valarm').length) addAlarm(vtodo);
}

/** A new title, in the display alarms' text too; the times and alarms stay as they are. */
export function rename(vtodo: ICAL.Component, title: string) {
  vtodo.updatePropertyWithValue('summary', title);
  for (const alarm of vtodo.getAllSubcomponents('valarm')) {
    if (alarm.getFirstPropertyValue('action') === 'DISPLAY') alarm.updatePropertyWithValue('description', title);
  }
}

function touch(vtodo: ICAL.Component) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vtodo.updatePropertyWithValue('dtstamp', now);
  vtodo.updatePropertyWithValue('last-modified', now);
  vtodo.updatePropertyWithValue('sequence', Number(vtodo.getFirstPropertyValue('sequence') ?? 0) + 1);
}

/** The VCALENDAR's VTODO (one per item). */
export function vtodoOf(ics: string): { root: ICAL.Component; vtodo: ICAL.Component } | undefined {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
  const vtodo = root.getFirstSubcomponent('vtodo');
  return vtodo ? { root, vtodo } : undefined;
}

/** A due time: "2026-11-13 15:00" (TZ) or with an offset; a bare date means 09:00. Not in the past. */
function dueTime(v: unknown): Date {
  const w = when(v, 'due');
  const at = w.date ? fromWall(w.date[0], w.date[1], w.date[2], 9, 0) : w.at;
  if (at.getTime() < Date.now() - 60_000) throw new HttpError(400, `due ${wall(at)} is in the past (now ${wall(new Date())}, ${tz})`);
  return at;
}

/** A repeat rule as iCalendar writes it (FREQ=WEEKLY;BYDAY=MO,TH; UNTIL or COUNT end it). */
function repeatRule(v: unknown): ICAL.Recur {
  const s = text(v).replace(/^RRULE:/i, '').toUpperCase();
  try {
    const r = ICAL.Recur.fromString(s);
    // a reminder repeats by days at most: hourly or faster isn't a reminder, and would take ages to step through
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq)) throw new Error('FREQ');
    return r;
  } catch {
    throw new HttpError(400, 'repeat must be an iCalendar rule, DAILY to YEARLY, like FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO,TH, FREQ=MONTHLY;BYMONTHDAY=1 or FREQ=YEARLY;UNTIL=20271231');
  }
}

// occurrences stepped through from a repeat's start (a daily one from 50 years ago is about 18,000)
const MAX_STEPS = 20_000;

/** An occurrence's due time: as far after the occurrence (a DTSTART) as the current due time is after DTSTART. */
function dueAfter(t: ICAL.Time, start: ICAL.Time, due: ICAL.Time): ICAL.Time {
  if (t.zone?.tzid === due.zone?.tzid && t.isDate === due.isDate) {
    // on the wall clock of their own zone, so 09:00–17:00 stays that across a DST change
    const d = t.clone();
    d.addDuration(due.subtractDate(start));
    return d;
  }
  return ICAL.Time.fromJSDate(new Date(wallOf(t).at.getTime() + wallOf(due).at.getTime() - wallOf(start).at.getTime()), true);
}

/**
 * Completes the to-do at `now`: a repeating one moves on to the first occurrence due after now and after the current
 * one (done early, it skips to the next; late, past the missed ones) and stays open, like the phones do. DTSTART and
 * DUE keep their zone and their distance, alarms set at a fixed time move along. One whose repeat has ended, or a
 * plain one, is marked completed.
 */
export function complete(vtodo: ICAL.Component, now: Date): { next: Date | null } {
  const rrule = vtodo.getFirstPropertyValue('rrule') as ICAL.Recur | null;
  const dueProp = vtodo.getFirstProperty('due');
  const startProp = vtodo.getFirstProperty('dtstart');
  if (rrule && dueProp) {
    const due = dueProp.getFirstValue() as ICAL.Time;
    // the occurrences are DTSTART's, in its own zone
    const start = (startProp?.getFirstValue() as ICAL.Time | undefined) ?? due;
    const current = wallOf(due).at;
    const it = rrule.iterator(start);
    for (let t = it.next(), index = 0; t; t = it.next(), index++) {
      if (index >= MAX_STEPS) throw new HttpError(400, 'the reminder is too far behind its repeat to step through: give it a new due time instead');
      const next = dueAfter(t, start, due);
      const at = wallOf(next).at;
      if (at <= now || at <= current) continue;
      // the series now starts here: a COUNT keeps only the occurrences left
      if (rrule.count) vtodo.updatePropertyWithValue('rrule', Object.assign(rrule.clone(), { count: rrule.count - index }));
      startProp?.setValue(t);
      dueProp.setValue(next);
      if (next.zone === ICAL.Timezone.utcTimezone) dueProp.removeParameter('tzid');
      shiftAlarms(vtodo, at.getTime() - current.getTime());
      touch(vtodo);
      return { next: at };
    }
  }
  vtodo.updatePropertyWithValue('status', 'COMPLETED');
  vtodo.updatePropertyWithValue('completed', ICAL.Time.fromJSDate(now, true));
  vtodo.updatePropertyWithValue('percent-complete', 100);
  touch(vtodo);
  return { next: null };
}

/** A new to-do's iCalendar text. */
export function newTodo(f: { title: string; due: Date | null; notes: string; repeat: ICAL.Recur | null }): string {
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('prodid', '-//alfred//api//EN');
  root.updatePropertyWithValue('version', '2.0');
  const vtodo = new ICAL.Component('vtodo');
  root.addSubcomponent(vtodo);
  vtodo.updatePropertyWithValue('uid', randomUUID().toUpperCase());
  vtodo.updatePropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  vtodo.updatePropertyWithValue('summary', f.title);
  vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
  if (f.notes) vtodo.updatePropertyWithValue('description', f.notes);
  setDue(vtodo, f.due);
  if (f.repeat) vtodo.updatePropertyWithValue('rrule', f.repeat);
  touch(vtodo);
  return root.toString();
}

// --- views ---

const oneLine = (v: unknown) => String(v ?? '').split(/\s*\n\s*/).filter(Boolean).join(', ').replace(/[ \t]+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function view(id: string, list: DAVCalendar, vtodo: ICAL.Component, notesMax = 200) {
  const due = vtodo.getFirstPropertyValue('due') as ICAL.Time | null;
  const w = due ? wallOf(due) : null;
  const done = vtodo.getFirstPropertyValue('status') === 'COMPLETED';
  const completed = vtodo.getFirstPropertyValue('completed') as ICAL.Time | null;
  const rrule = vtodo.getFirstPropertyValue('rrule');
  return {
    id, list: listName(list), title: oneLine(vtodo.getFirstPropertyValue('summary')),
    due: w?.shown ?? null, weekday: w ? weekday(w.at) : null, overdue: Boolean(w && !done && w.at.getTime() < Date.now()),
    alarm: vtodo.getAllSubcomponents('valarm').length > 0, repeats: rrule ? rrule.toString() : null,
    done, completed: completed ? wall(completed.toJSDate()) : null,
    notes: clip(oneLine(vtodo.getFirstPropertyValue('description')), notesMax),
  };
}

type View = ReturnType<typeof view>;

function line(t: View): string {
  return [
    `[${t.id}] ${t.done ? '✓ ' : ''}${t.title}`,
    t.due ? `due ${t.weekday} ${t.due}${t.overdue ? ' (overdue)' : ''}${t.alarm ? '' : ' (no alarm)'}` : 'no date',
    t.repeats && `repeats ${t.repeats}`, t.done && t.completed && `done ${t.completed}`, t.list, t.notes && `notes: ${t.notes}`,
  ].filter(Boolean).join(' | ');
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** GET /todos: the open reminders (with done=true the completed ones too), by words and list; by due time. */
export async function listTodos(q: Query) {
  const { client, lists: all } = await lists();
  const only = param(q, 'list');
  const chosen = only ? [pickList(all, only)] : all;
  const withDone = ['true', '1', 'yes'].includes((param(q, 'done') ?? '').toLowerCase());
  const words = fold(param(q, 'q') ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
  const todos: View[] = [];
  await Promise.all(chosen.map(async (list) => {
    for (const object of await client.fetchCalendarObjects({ calendar: list, filters: VTODO_FILTER })) {
      const parsed = object.data && vtodoOf(object.data);
      if (!parsed) continue;
      const t = view(idOf(object.url, list), list, parsed.vtodo);
      if ((withDone || !t.done) && words.every((w) => fold(`${t.title} ${t.notes}`).includes(w))) todos.push(t);
    }
  }));
  // open before done; by due time, those without one last; done ones most recent first
  todos.sort((a, b) => Number(a.done) - Number(b.done)
    || (a.done ? (b.completed ?? '').localeCompare(a.completed ?? '') : (a.due ?? '~').localeCompare(b.due ?? '~')));
  const shown = todos.slice(0, MAX_LISTED);
  const lines = shown.length ? shown.map(line) : [`No ${withDone ? '' : 'open '}reminders${words.length ? ' matching the search' : ''}.`];
  if (todos.length > shown.length) lines.push(`… and ${todos.length - shown.length} more: narrow with q or list.`);
  lines.push(`Lists: ${all.map(listName).join(', ')} (times in ${tz})`);
  return { todos: shown, text: lines.join('\n') };
}

function check(res: Response, what: string) {
  if (res.status === 412) throw new HttpError(409, `the reminder changed meanwhile (on a phone?): list the reminders again, then ${what}`);
  if (!res.ok) throw new HttpError(502, `Radicale refused to ${what} (HTTP ${res.status})`);
}

const has = (body: Record<string, unknown>, k: string) => body[k] !== undefined && text(body[k]) !== '';

function title(v: unknown): string {
  const s = text(v);
  if (s.length > MAX_TEXT) throw new HttpError(400, `title: at most ${MAX_TEXT} characters`);
  return s;
}

/** POST /todos: title, due (2026-11-13 15:00; a bare date means 09:00; none: no date and no alarm), notes, repeat, list. */
export async function createTodo(body: Record<string, unknown>) {
  if (!has(body, 'title')) throw new HttpError(400, 'title is required');
  const repeat = has(body, 'repeat') ? repeatRule(body.repeat) : null;
  const due = has(body, 'due') ? dueTime(body.due) : null;
  if (repeat && !due) throw new HttpError(400, 'a repeating reminder needs a due time for its first occurrence');
  const { client, lists: all } = await lists();
  const list = pickList(all, text(body.list));
  const ics = newTodo({ title: title(body.title), due, notes: has(body, 'notes') ? text(body.notes) : '', repeat });
  const filename = `${vtodoOf(ics)!.vtodo.getFirstPropertyValue('uid')}.ics`;
  check(await client.createCalendarObject({ calendar: list, filename, iCalString: ics }), 'create the reminder');
  const t = view(idOf(new URL(filename, list.url).href, list), list, vtodoOf(ics)!.vtodo, MAX_TEXT);
  return { todo: t, text: `Created: ${line(t)}` };
}

/** PATCH /todos/<id>: title, due, notes, repeat; empty ones are kept, "-" removes a due time, notes or a repeat. */
export async function updateTodo(id: string, body: Record<string, unknown>) {
  const changes = ['title', 'due', 'notes', 'repeat'].filter((k) => has(body, k));
  if (!changes.length) throw new HttpError(400, 'nothing to change: give title, due, notes or repeat');
  const { client, list, object } = await objectOf(id);
  const { root, vtodo } = vtodoOf(object.data)!;
  if (has(body, 'title')) rename(vtodo, title(body.title));
  if (has(body, 'notes')) {
    if (text(body.notes) === '-') vtodo.removeAllProperties('description');
    else vtodo.updatePropertyWithValue('description', text(body.notes));
  }
  if (has(body, 'repeat')) {
    if (text(body.repeat) === '-') vtodo.removeAllProperties('rrule');
    else vtodo.updatePropertyWithValue('rrule', repeatRule(body.repeat));
  }
  if (has(body, 'due')) {
    const due = text(body.due) === '-' ? null : dueTime(body.due);
    setDue(vtodo, due);
    // a new due time on a done reminder brings it back
    if (due && vtodo.getFirstPropertyValue('status') === 'COMPLETED') {
      vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
      for (const name of ['completed', 'percent-complete']) vtodo.removeAllProperties(name);
    }
  }
  if (vtodo.hasProperty('rrule') && !vtodo.hasProperty('due')) throw new HttpError(400, 'a repeating reminder needs a due time: remove the repeat too (repeat "-")');
  touch(vtodo);
  const ics = root.toString();
  check(await client.updateCalendarObject({ calendarObject: { url: object.url, etag: object.etag, data: ics } }), 'change the reminder');
  const t = view(id, list, vtodo, MAX_TEXT);
  return { todo: t, text: `Changed: ${line(t)}` };
}

/** POST /todos/<id>/done: completes it; a repeating one moves on to its next occurrence instead. */
export async function doneTodo(id: string) {
  const { client, list, object } = await objectOf(id);
  const { root, vtodo } = vtodoOf(object.data)!;
  if (vtodo.getFirstPropertyValue('status') === 'COMPLETED') return { todo: view(id, list, vtodo), text: `Already done: ${oneLine(vtodo.getFirstPropertyValue('summary'))}` };
  const { next } = complete(vtodo, new Date());
  check(await client.updateCalendarObject({ calendarObject: { url: object.url, etag: object.etag, data: root.toString() } }), 'complete the reminder');
  const t = view(id, list, vtodo);
  return { todo: t, text: next ? `Done; it repeats, next: ${line(t)}` : `Done: ${line(t)}` };
}

/** DELETE /todos/<id>: deletes it, a repeating one with all its occurrences. */
export async function deleteTodo(id: string) {
  const { client, object } = await objectOf(id);
  const summary = oneLine(vtodoOf(object.data)?.vtodo.getFirstPropertyValue('summary'));
  check(await client.deleteCalendarObject({ calendarObject: { url: object.url, etag: object.etag } }), 'delete the reminder');
  known.delete(id);
  return { deleted: id, text: `Deleted: ${summary}` };
}
