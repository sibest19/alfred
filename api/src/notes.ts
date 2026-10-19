// Notes: an assistant's long-term memory. Each note can sit under a topic (a path like "people/giulia" whose
// first segment comes from a fixed list), a topic can have one summary note (kind 'summary'), and notes merged
// into another stay in the table, archived with merged_into, so every merge can be undone.
import { sql } from '@alfred/db';
import { config } from './config.js';
import { and, HttpError, intParam, like, oneOf, param, text, tags, tsQuery, tz, type Query } from './http.js';

const NOTE_KINDS = ['note', 'fact', 'preference', 'idea', 'link', 'todo', 'summary'] as const;
const NOTE_SOURCES = ['user', 'assistant'] as const;
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** A topic path: lowercase, accents and spaces folded ("Persone/Giulia Rossi" → "persone/giulia-rossi"), 1-4 levels. */
function topic(v: unknown): string | null {
  const raw = text(v);
  if (!raw) return null;
  const path = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split('/')
    .map((s) => s.trim().replace(/\s+/g, '-'))
    .filter(Boolean);
  if (path.length === 0 || path.length > 4 || !path.every((s) => SEGMENT.test(s))) {
    throw new HttpError(400, `topic must be a path of 1-4 lowercase words, e.g. ${config.noteTopicRoots[0]}/name`);
  }
  if (!config.noteTopicRoots.includes(path[0])) {
    throw new HttpError(400, `a topic starts with one of: ${config.noteTopicRoots.join(', ')}`);
  }
  return path.join('/');
}

const noteColumns = sql`
  id::int AS id, kind, topic, title, content, tags, source,
  to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS created, to_char(updated_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS updated`;
const archivedColumns = sql`, deleted_at IS NOT NULL AS archived, merged_into::int AS merged_into`;

const underTopic = (t: string) => sql`(topic = ${t} OR topic LIKE ${t.replace(/[\\%_]/g, (c) => `\\${c}`) + '/%'})`;

export async function searchNotes(q: Query) {
  const words = param(q, 'q');
  const ts = tsQuery(words, true);
  const tag = param(q, 'tag')?.toLowerCase();
  const kind = oneOf(param(q, 'kind'), NOTE_KINDS, 'kind');
  const t = topic(param(q, 'topic'));
  const archived = param(q, 'archived') === 'true';
  const limit = intParam(q, 'limit', 20, 500);
  const match = ts
    ? sql`(search @@ to_tsquery('simple', ${ts}) OR title ILIKE ${like(words!)} OR content ILIKE ${like(words!)}
           OR topic ILIKE ${like(words!)} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE ${like(words!)}))`
    : undefined;
  const rows = await sql`
    SELECT ${noteColumns} ${archived ? archivedColumns : sql``} FROM notes
    WHERE ${and([
      archived ? undefined : sql`deleted_at IS NULL`,
      match,
      tag ? sql`${tag} = ANY (tags)` : undefined,
      kind ? sql`kind = ${kind}` : undefined,
      t ? underTopic(t) : undefined,
    ])}
    ORDER BY (kind = 'summary') DESC, ${ts ? sql`ts_rank(search, to_tsquery('simple', ${ts})) DESC,` : sql``} updated_at DESC
    LIMIT ${limit}`;
  return { count: rows.length, notes: rows };
}

export async function createNote(body: Record<string, unknown>, db: typeof sql = sql) {
  const title = text(body.title);
  const content = text(body.content);
  if (!title || !content) throw new HttpError(400, 'title and content are required');
  const kind = oneOf(text(body.kind) || 'note', NOTE_KINDS, 'kind')!;
  if (kind === 'summary') throw new HttpError(400, 'write summaries with PUT /notes/summaries');
  const source = oneOf(text(body.source) || 'assistant', NOTE_SOURCES, 'source')!;
  const [note] = await db`
    INSERT INTO notes (kind, topic, title, content, tags, source)
    VALUES (${kind}, ${topic(body.topic)}, ${title}, ${content}, ${tags(body.tags)}, ${source})
    RETURNING ${noteColumns}`;
  return note;
}

export async function updateNote(id: string, body: Record<string, unknown>, db: typeof sql = sql) {
  const title = text(body.title) || null;
  const content = text(body.content) || null;
  const kind = oneOf(text(body.kind) || undefined, NOTE_KINDS, 'kind') ?? null;
  const newTopic = topic(body.topic);
  // absent or empty keeps the tags; to clear them, send []
  const newTags = body.tags === undefined || text(body.tags) === '' ? null : tags(body.tags);
  const [note] = await db`
    UPDATE notes SET title = coalesce(${title}, title), content = coalesce(${content}, content), kind = coalesce(${kind}, kind),
      topic = coalesce(${newTopic}, topic), tags = coalesce(${newTags}::text[], tags), updated_at = now()
    WHERE id = ${id}::bigint AND deleted_at IS NULL RETURNING ${noteColumns}`;
  if (!note) throw new HttpError(404, `no note ${id}`);
  return note;
}

export async function deleteNote(id: string) {
  const [note] = await sql`UPDATE notes SET deleted_at = now() WHERE id = ${id}::bigint AND deleted_at IS NULL RETURNING id::int AS id, title`;
  if (!note) throw new HttpError(404, `no note ${id}`);
  return { deleted: note };
}

/** Brings back a deleted or merged note. */
export async function restoreNote(id: string) {
  try {
    const [note] = await sql`
      UPDATE notes SET deleted_at = NULL, merged_into = NULL, updated_at = now()
      WHERE id = ${id}::bigint AND deleted_at IS NOT NULL RETURNING ${noteColumns}`;
    if (!note) throw new HttpError(404, `no deleted or merged note ${id}`);
    return { restored: note };
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'that topic already has a summary: delete or merge it first');
    throw err;
  }
}

/**
 * Merges notes: `ids` are archived with merged_into pointing at the result. The result is `into` (an existing
 * note, updated with the fields given) or, without `into`, a new note made from the fields.
 */
export async function mergeNotes(body: Record<string, unknown>) {
  const ids = (Array.isArray(body.ids) ? body.ids : text(body.ids).split(','))
    .map((v) => Number.parseInt(String(v), 10))
    .filter(Number.isInteger);
  const into = body.into === undefined || text(body.into) === '' ? null : Number.parseInt(text(body.into), 10);
  if (ids.length === 0 || (into === null && ids.length < 2)) throw new HttpError(400, 'ids: at least two notes, or one plus into');
  if (into !== null && (!Number.isInteger(into) || ids.includes(into))) throw new HttpError(400, 'into must be another note id');
  return sql.begin(async (t) => {
    const tx = t as unknown as typeof sql; // same query API; the cast lets createNote/updateNote run inside it
    const found = await tx`
      SELECT id::int AS id FROM notes WHERE id = ANY (${ids}::bigint[]) AND deleted_at IS NULL AND kind <> 'summary' FOR UPDATE`;
    const missing = ids.filter((i) => !found.some((r) => r.id === i));
    if (missing.length) throw new HttpError(404, `not active notes (or summaries): ${missing.join(', ')}`);
    let target;
    if (into !== null) {
      const fields = { title: body.title, content: body.content, tags: body.tags, topic: body.topic, kind: body.kind };
      target = await updateNote(String(into), fields, tx).catch((err) => {
        throw err instanceof HttpError && err.status === 404 ? new HttpError(404, `no active note ${into}`) : err;
      });
    } else {
      target = await createNote({ ...body, source: body.source ?? 'assistant' }, tx);
    }
    await tx`UPDATE notes SET deleted_at = now(), merged_into = ${target.id} WHERE id = ANY (${ids}::bigint[])`;
    return { merged: ids, into: target };
  });
}

/** Creates or replaces the summary note of a topic. */
export async function putSummary(body: Record<string, unknown>) {
  const t = topic(body.topic);
  const content = text(body.content);
  if (!t || !content) throw new HttpError(400, 'topic and content are required');
  const title = text(body.title) || t;
  const [updated] = await sql`
    UPDATE notes SET title = ${title}, content = ${content}, tags = coalesce(${body.tags === undefined ? null : tags(body.tags)}::text[], tags),
      updated_at = now()
    WHERE kind = 'summary' AND topic = ${t} AND deleted_at IS NULL RETURNING ${noteColumns}`;
  if (updated) return updated;
  const [created] = await sql`
    INSERT INTO notes (kind, topic, title, content, tags, source) VALUES ('summary', ${t}, ${title}, ${content}, ${tags(body.tags)}, 'assistant')
    RETURNING ${noteColumns}`;
  return created;
}

/** The topic index: every topic with its note count and the start of its summary, plus a text rendering for prompts. */
export async function topics() {
  const rows = await sql`
    SELECT coalesce(topic, '') AS topic, count(*) FILTER (WHERE kind <> 'summary')::int AS notes,
      max(left(regexp_replace(content, '\\s+', ' ', 'g'), 160)) FILTER (WHERE kind = 'summary') AS summary
    FROM notes WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1`;
  const lines = rows.map((r) =>
    r.topic
      ? `${r.topic} (${r.notes})${r.summary ? `: ${r.summary}` : ''}`
      : `(no topic) (${r.notes})`,
  );
  return { roots: config.noteTopicRoots, count: rows.length, topics: rows, text: lines.join('\n') || '(no notes yet)' };
}

// --- consolidation runs ---

/** What changed since the last consolidation finished: notes created, updated or deleted after it. */
export async function pendingConsolidation() {
  const [last] = await sql`SELECT finished_at FROM consolidations ORDER BY finished_at DESC LIMIT 1`;
  const since = last?.finished_at ?? null;
  const rows = since
    ? await sql`SELECT id::int AS id FROM notes WHERE greatest(created_at, updated_at, coalesce(deleted_at, created_at)) > ${since} ORDER BY id`
    : await sql`SELECT id::int AS id FROM notes ORDER BY id`;
  const [{ active }] = await sql`SELECT count(*)::int AS active FROM notes WHERE deleted_at IS NULL`;
  return {
    since: since && (await sql`SELECT to_char(${since}::timestamptz AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS t`)[0].t,
    changed: rows.length,
    changed_ids: rows.map((r) => r.id),
    active_notes: active,
  };
}

export async function recordConsolidation(body: Record<string, unknown>) {
  const started = text(body.started_at);
  if (!started || Number.isNaN(Date.parse(started))) throw new HttpError(400, 'started_at must be an ISO date-time');
  const changes = Number.parseInt(text(body.changes) || '0', 10);
  const [run] = await sql`
    INSERT INTO consolidations (started_at, changes, report) VALUES (${started}::timestamptz, ${Number.isInteger(changes) ? changes : 0}, ${text(body.report) || null})
    RETURNING id::int AS id, to_char(finished_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS finished`;
  return run;
}
