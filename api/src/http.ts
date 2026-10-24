// Request parsing and SQL helpers shared by the route modules.
import type { IncomingMessage } from 'node:http';
import type { PendingQuery, Row } from 'postgres';
import { sql } from '@alfred/db';
import { config } from './config.js';

export const tz = config.timezone;
export const MAX_JSON = 1024 * 1024;
export const MAX_AUDIO = 25 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Query = URLSearchParams;
export type Fragment = PendingQuery<Row[]>;

// --- request helpers ---

/** A query parameter; empty means absent (tools tend to send every parameter, filled or not). */
export const param = (q: Query, name: string) => q.get(name)?.trim() || undefined;

export function intParam(q: Query, name: string, fallback: number, max: number): number {
  const raw = param(q, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return Math.min(n, max);
}

export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A date or date-time; without an offset it's in the API's time zone. A bare date as `to` includes that day. */
export function timeBound(value: string | undefined, name: string, end: boolean): Fragment | undefined {
  if (value === undefined) return undefined;
  if (!DATE.test(value)) throw new HttpError(400, `${name} must look like 2026-10-01 or 2026-10-01 18:30`);
  const local = !/(Z|[+-]\d{2}:?\d{2})$/.test(value);
  // through text: a parameter typed timestamp goes through a JS Date, which reads it in the process's zone
  const t = local ? sql`(${value}::text::timestamp AT TIME ZONE ${tz})` : sql`${value}::text::timestamptz`;
  return end && value.length === 10 ? sql`${t} + interval '1 day'` : t;
}

/** Words to a prefix tsquery ("cena sabato" → cena:* & sabato:*), or undefined when there are none. */
export function tsQuery(text: string | undefined, any: boolean): string | undefined {
  let words: string[] | undefined = text?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? undefined;
  // with any word enough, short ones ("da", "il") as prefixes match almost everything
  if (any && words?.some((w) => w.length >= 3)) words = words.filter((w) => w.length >= 3);
  return words?.length ? words.map((w) => `${w}:*`).join(any ? ' | ' : ' & ') : undefined;
}

export const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const and = (parts: (Fragment | undefined)[]): Fragment =>
  parts.filter((p): p is Fragment => p !== undefined).reduce((acc, p) => sql`${acc} AND ${p}`, sql`TRUE`);

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MAX_JSON);
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, 'body must be a JSON object');
}

export const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/** Tags as a JSON array or a comma-separated string; lowercase, unique. */
export function tags(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(text) : text(v).split(',');
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

