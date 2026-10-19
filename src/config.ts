// Settings from the environment. Postgres connection comes from the standard PG* variables
// (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD), which the postgres client reads itself.

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
};

export const config = {
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Baileys logs a lot at info; its own level is separate.
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
  httpPort: int('HTTP_PORT', 8080),
  mediaDir: process.env.MEDIA_DIR ?? '/media',
  // Digits only, with country code (e.g. 393331234567): pair with a code instead of the QR.
  pairingPhone: (process.env.WA_PAIRING_PHONE ?? '').replace(/\D/g, ''),
  // Linked-device identity, "<os>:<browser>" (os: ubuntu | macOS | windows). A 'Desktop' browser asks the
  // phone for the full history; 'Chrome' is what pairing codes are known to work with.
  browser: (process.env.WA_BROWSER || 'ubuntu:Desktop').split(':') as [string, string],
  mediaConcurrency: int('MEDIA_CONCURRENCY', 2),
  // Larger files are recorded but not downloaded.
  mediaMaxBytes: int('MEDIA_MAX_MB', 100) * 1024 * 1024,
  // Media in history sync older than this is recorded but not downloaded (0 = download none).
  mediaHistoryDays: int('MEDIA_HISTORY_DAYS', 90),
  mediaMaxAttempts: int('MEDIA_MAX_ATTEMPTS', 8),
  // Speech-to-text service for downloaded audio (POST <url>/transcribe); empty disables it.
  transcriberUrl: (process.env.TRANSCRIBER_URL ?? '').replace(/\/+$/, ''),
};
