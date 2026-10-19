// Settings from the environment; Postgres comes from the standard PG* variables (see @alfred/db).
const port = Number.parseInt(process.env.HTTP_PORT || '8080', 10);
if (!Number.isFinite(port)) throw new Error(`HTTP_PORT must be an integer, got "${process.env.HTTP_PORT}"`);

export const config = {
  logLevel: process.env.LOG_LEVEL ?? 'info',
  httpPort: port,
  // The bearer token every request but /health must carry.
  apiToken: process.env.API_TOKEN ?? '',
  // Dates without an offset are read, and all dates shown, in this zone.
  timezone: process.env.TZ || 'UTC',
  // Speech-to-text service behind POST /transcribe; empty disables it.
  // First level of a note's topic path; the order is the one shown to the assistant.
  noteTopicRoots: (process.env.NOTE_TOPIC_ROOTS || 'people,places,preferences,home,work,health,projects,ideas,reading,travel,other')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  transcriberUrl: (process.env.TRANSCRIBER_URL ?? '').replace(/\/+$/, ''),
};
