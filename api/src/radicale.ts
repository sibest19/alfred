// A Radicale (CalDAV) server: the calendars and to-do lists under RADICALE_HOME, read and written as RADICALE_USER,
// which may be a delegate acting on another user's collections. No discovery: Radicale checks the password (bcrypt)
// on every request, so the account comes from the configuration and the collections are listed every ten minutes.
import {
  createCalendarObject, deleteCalendarObject, fetchCalendarObjects, fetchCalendars, getBasicAuthHeaders, updateCalendarObject,
  type DAVCalendar,
} from 'tsdav';
import { config } from './config.js';
import { HttpError } from './http.js';

const DISCOVERY_TTL = 10 * 60_000;

/** The calls the calendar and to-do routes make, with the login added: the same shape as a tsdav client's. */
export type Dav = {
  fetchCalendarObjects: (p: Omit<Parameters<typeof fetchCalendarObjects>[0], 'headers'>) => ReturnType<typeof fetchCalendarObjects>;
  createCalendarObject: (p: Omit<Parameters<typeof createCalendarObject>[0], 'headers'>) => ReturnType<typeof createCalendarObject>;
  updateCalendarObject: (p: Omit<Parameters<typeof updateCalendarObject>[0], 'headers'>) => ReturnType<typeof updateCalendarObject>;
  deleteCalendarObject: (p: Omit<Parameters<typeof deleteCalendarObject>[0], 'headers'>) => ReturnType<typeof deleteCalendarObject>;
};

let session: { client: Dav; calendars: DAVCalendar[]; at: number } | undefined;

const baseName = (c: DAVCalendar) => (typeof c.displayName === 'string' && c.displayName.trim()) || c.url.split('/').filter(Boolean).pop()!;

/**
 * A name per collection (by URL) that picks exactly one, ignoring case as the lookups do: each display name as it is
 * for the first collection carrying it, unless another collection's own name already is that; the others get the
 * first free " (2)", " (3)"…
 */
export function collectionNames(collections: DAVCalendar[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const c of collections) {
    const name = baseName(c);
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      names.set(c.url, name);
    }
  }
  for (const c of collections) {
    if (names.has(c.url)) continue;
    let n = 2;
    while (used.has(`${baseName(c)} (${n})`.toLowerCase())) n++;
    used.add(`${baseName(c)} (${n})`.toLowerCase());
    names.set(c.url, `${baseName(c)} (${n})`);
  }
  return names;
}

/** The collection's name from `names`, or its own when it isn't there. */
export const nameIn = (names: Map<string, string>, c: DAVCalendar) => names.get(c.url) ?? baseName(c);

export const radicaleConfigured = () => Boolean(config.radicale.url && config.radicale.user && config.radicale.password);

/** The client and every collection under the home, VEVENT and VTODO alike. */
export async function radicale(): Promise<{ client: Dav; calendars: DAVCalendar[] }> {
  if (!radicaleConfigured()) throw new HttpError(503, 'Radicale is not configured (RADICALE_URL, RADICALE_USER, RADICALE_PASSWORD)');
  if (session && Date.now() - session.at < DISCOVERY_TTL) return session;
  const { url, user, password, home } = config.radicale;
  const headers = getBasicAuthHeaders({ username: user, password });
  const client: Dav = {
    fetchCalendarObjects: (p) => fetchCalendarObjects({ ...p, headers }),
    createCalendarObject: (p) => createCalendarObject({ ...p, headers }),
    updateCalendarObject: (p) => updateCalendarObject({ ...p, headers }),
    deleteCalendarObject: (p) => deleteCalendarObject({ ...p, headers }),
  };
  const rootUrl = new URL('/', url).href;
  try {
    const calendars = await fetchCalendars({ account: { accountType: 'caldav', serverUrl: url, rootUrl, homeUrl: new URL(home, url).href }, headers });
    session = { client, calendars, at: Date.now() };
    return session;
  } catch (err: any) {
    const message = String(err?.message ?? err);
    if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) throw new HttpError(502, 'Radicale refused the login: check RADICALE_USER, RADICALE_PASSWORD and RADICALE_HOME');
    throw new HttpError(502, `Radicale is unreachable: ${message}`);
  }
}
