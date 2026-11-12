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
