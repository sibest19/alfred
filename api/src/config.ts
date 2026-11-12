// Settings from the environment; Postgres comes from the standard PG* variables (see @alfred/db).
const port = Number.parseInt(process.env.HTTP_PORT || '8080', 10);
if (!Number.isFinite(port)) throw new Error(`HTTP_PORT must be an integer, got "${process.env.HTTP_PORT}"`);

/** GMAIL_ACCOUNTS: {"<name>": {"user": "<address>", "password": "<app password>"}}; names are short lowercase words. */
export function parseGmailAccounts(raw: string): Record<string, { user: string; password: string }> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('GMAIL_ACCOUNTS must be a JSON object');
  for (const [name, a] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]{1,32}$/.test(name) || name === 'icloud') throw new Error(`GMAIL_ACCOUNTS: "${name}" is not a valid account name`);
    if (typeof a?.user !== 'string' || !a.user || typeof a?.password !== 'string' || !a.password)
      throw new Error(`GMAIL_ACCOUNTS: "${name}" needs user and password`);
  }
  return parsed as Record<string, { user: string; password: string }>;
}

export const config = {
  logLevel: process.env.LOG_LEVEL ?? 'info',
  httpPort: port,
  // Legacy bearer token with full API access; scoped credentials are opt-in.
  apiToken: process.env.API_TOKEN ?? '',
  apiScopedTokens: process.env.API_SCOPED_TOKENS ?? '{}',
  // Dates without an offset are read, and all dates shown, in this zone.
  timezone: process.env.TZ || 'UTC',
  // Speech-to-text service behind POST /transcribe; empty disables it.
  // First level of a note's topic path; the order is the one shown to the assistant.
  noteTopicRoots: (process.env.NOTE_TOPIC_ROOTS || 'people,places,preferences,home,work,health,projects,ideas,reading,travel,other')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  transcriberUrl: (process.env.TRANSCRIBER_URL ?? '').replace(/\/+$/, ''),
  // iCloud Mail (IMAP) and Calendar (CalDAV): the Apple ID and an app-specific password; empty disables both.
  icloud: {
    user: process.env.ICLOUD_USER ?? '',
    password: process.env.ICLOUD_PASSWORD ?? '',
    // New events go to this calendar unless the request names one; empty means the first calendar.
    calendar: process.env.ICLOUD_CALENDAR ?? '',
  },
  // Gmail accounts over IMAP, each with an app password; read like iCloud Mail, by name.
  gmail: parseGmailAccounts(process.env.GMAIL_ACCOUNTS || '{}'),
  // A Radicale server: its calendars join iCloud's, its to-do lists are the reminders. Empty URL disables it.
  radicale: {
    url: process.env.RADICALE_URL ?? '',
    user: process.env.RADICALE_USER ?? '',
    password: process.env.RADICALE_PASSWORD ?? '',
    // The collections used, e.g. another user's that RADICALE_USER may act on; the user's own by default.
    home: process.env.RADICALE_HOME || `/${process.env.RADICALE_USER ?? ''}/`,
  },
};
