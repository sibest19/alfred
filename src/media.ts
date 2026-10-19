// Downloads queued media into MEDIA_DIR/<yyyy>/<mm>/<msg_id>.<ext>. The queue lives in the media
// table, so a restart resumes where it stopped. Expired media (WhatsApp keeps files for a limited
// time) is re-requested from the phone once via Baileys' reupload; if that fails too it's 'expired'.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { downloadMediaMessage, type WAMessage, type WASocket } from 'baileys';
import type { Logger } from 'pino';
import { config } from './config.js';
import type { Sql } from './db.js';
import { fromJson } from './ingest.js';
import { metrics } from './metrics.js';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

function extension(mimetype: string | null, fileName: string | null): string {
  const fromName = fileName ? extname(fileName).slice(1).toLowerCase() : '';
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const base = (mimetype ?? '').split(';')[0].trim();
  return EXT[base] ?? 'bin';
}

type Row = {
  message_id: string;
  msg_id: string;
  mimetype: string | null;
  file_name: string | null;
  attempts: number;
  sent_at: Date;
  raw: unknown;
};

export class MediaWorker {
  private running = false;

  constructor(
    private sql: Sql,
    private log: Logger,
    private socket: () => WASocket | undefined,
  ) {}

  /** Drains the due part of the queue; no-op if already running or not connected. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.socket()) {
        const rows = await this.sql<Row[]>`
          SELECT md.message_id, m.msg_id, md.mimetype, md.file_name, md.attempts, m.sent_at, m.raw
          FROM media md JOIN messages m ON m.id = md.message_id
          WHERE md.status = 'pending' AND md.next_attempt_at <= now()
          ORDER BY m.sent_at DESC
          LIMIT ${config.mediaConcurrency * 4}`;
        if (rows.length === 0) break;
        for (let i = 0; i < rows.length; i += config.mediaConcurrency) {
          await Promise.all(rows.slice(i, i + config.mediaConcurrency).map((r) => this.download(r)));
        }
      }
    } catch (err) {
      this.log.error({ err }, 'media queue failed');
    } finally {
      this.running = false;
    }
  }

  private async download(row: Row) {
    const sock = this.socket();
    if (!sock) return;
    const yyyy = String(row.sent_at.getUTCFullYear());
    const mm = String(row.sent_at.getUTCMonth() + 1).padStart(2, '0');
    const rel = join(yyyy, mm, `${row.msg_id.replace(/[^A-Za-z0-9_-]/g, '_')}.${extension(row.mimetype, row.file_name)}`);
    const abs = join(config.mediaDir, rel);
    const tmp = `${abs}.part`;
    try {
      const msg = fromJson<WAMessage>(row.raw);
      const stream = await downloadMediaMessage(
        msg,
        'stream',
        {},
        { logger: this.log as any, reuploadRequest: (m) => sock.updateMediaMessage(m) },
      );
      await mkdir(dirname(abs), { recursive: true });
      const hash = createHash('sha256');
      let size = 0;
      const tap = new Transform({
        transform(chunk, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(stream, tap, createWriteStream(tmp));
      await rename(tmp, abs);
      await this.sql`
        UPDATE media SET status = 'done', path = ${rel}, sha256 = ${hash.digest('hex')}, downloaded_at = now(),
          file_length = coalesce(file_length, ${size}), attempts = attempts + 1, last_error = NULL
        WHERE message_id = ${row.message_id}`;
      metrics.mediaDownloads.inc({ result: 'done' });
    } catch (err: any) {
      await rm(tmp, { force: true });
      const code = err?.output?.statusCode ?? err?.status ?? err?.response?.status;
      const text = String(err?.message ?? err).slice(0, 500);
      const gone = code === 404 || code === 410 || /\b(404|410)\b|gone|not found/i.test(text);
      const attempts = row.attempts + 1;
      const status = gone ? 'expired' : attempts >= config.mediaMaxAttempts ? 'failed' : 'pending';
      const delayMin = Math.min(2 ** attempts, 360);
      await this.sql`
        UPDATE media SET status = ${status}, attempts = ${attempts}, last_error = ${text},
          next_attempt_at = now() + make_interval(mins => ${delayMin})
        WHERE message_id = ${row.message_id}`;
      metrics.mediaDownloads.inc({ result: status === 'pending' ? 'retry' : status });
      this.log.warn({ msgId: row.msg_id, status, attempts, err: text }, 'media download failed');
    }
  }
}
