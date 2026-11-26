import { timingSafeEqual } from 'node:crypto';

export const SCOPES = [
  'archive.read', 'notes.read', 'notes.write', 'notes.delete', 'notes.consolidate',
  'reminders.read', 'reminders.manage', 'reminders.claim', 'mail.read',
  'calendar.read', 'calendar.create', 'calendar.update', 'calendar.delete', 'todos.read', 'todos.manage', 'audio.transcribe',
] as const;
export type Scope = typeof SCOPES[number];

/** The legacy token keeps its permissions; new credentials receive only explicit scopes. A caller is named by its
 * key in API_SCOPED_TOKENS (`legacy` for API_TOKEN), for the request log, never by its token. */
export function createAuthorizer(legacyToken: string, scopedTokens = '{}') {
  if (Buffer.byteLength(legacyToken) < 16) throw new Error('API_TOKEN must be set (16 bytes or more)');
  const credentials: { name: string; token: Buffer; scopes: ReadonlySet<Scope> }[] = [
    { name: 'legacy', token: Buffer.from(legacyToken), scopes: new Set(SCOPES) },
  ];
  let parsed: unknown;
  try { parsed = JSON.parse(scopedTokens); }
  catch { throw new Error('API_SCOPED_TOKENS must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('API_SCOPED_TOKENS must be a JSON object');
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Each scoped credential must contain token and scopes');
    }
    const { token, scopes, ...extra } = value as Record<string, unknown>;
    if (Object.keys(extra).length || typeof token !== 'string' || Buffer.byteLength(token) < 16 || /\s/.test(token)) {
      throw new Error('Scoped tokens must have at least 16 bytes, no whitespace and only token/scopes fields');
    }
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) {
      throw new Error('Scoped credentials must have a non-empty array of known scopes');
    }
    const bytes = Buffer.from(token);
    if (credentials.some((c) => c.token.length === bytes.length && timingSafeEqual(c.token, bytes))) {
      throw new Error('API credentials must use distinct tokens');
    }
    credentials.push({ name, token: bytes, scopes: new Set(scopes) });
  }
  return (header: string | undefined): { name: string; scopes: ReadonlySet<Scope> } | undefined => {
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
    const match = credentials.find((c) => c.token.length === given.length && timingSafeEqual(c.token, given));
    return match && { name: match.name, scopes: match.scopes };
  };
}
