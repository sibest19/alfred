// Sends downloaded audio to the transcriber service (POST <TRANSCRIBER_URL>/transcribe, raw body) and stores
// the text in media.transcript and messages.body. Newest first; a failure is retried twice, spaced out with
// media.next_attempt_at (the download queue doesn't look at it once a file is 'done').
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { config } from './config.js';
import type { Sql } from '@alfred/db';
import { metrics } from './metrics.js';

type Row = { message_id: string; msg_id: string; path: string; mimetype: string | null; transcribe_attempts: number };

export class Transcriber {
  private running = false;

  constructor(
    private sql: Sql,
    private log: Logger,
  ) {}

  async tick() {
    if (!config.transcriberUrl || this.running) return;
    this.running = true;
    try {
      for (;;) {
        const rows = await this.sql<Row[]>`
          SELECT md.message_id, m.msg_id, md.path, md.mimetype, md.transcribe_attempts
          FROM media md JOIN messages m ON m.id = md.message_id
          WHERE md.kind = 'audio' AND md.status = 'done' AND md.transcribed_at IS NULL
            AND md.transcribe_attempts < 3 AND md.next_attempt_at <= now()
          ORDER BY m.sent_at DESC
          LIMIT 20`;
        if (rows.length === 0) break;
        for (const row of rows) await this.transcribe(row);
      }
    } catch (err) {
      this.log.error({ err }, 'transcription queue failed');
    } finally {
      this.running = false;
    }
  }

  private async transcribe(row: Row) {
    try {
      const audio = await readFile(join(config.mediaDir, row.path));
      const res = await fetch(`${config.transcriberUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': row.mimetype?.split(';')[0] || 'application/octet-stream' },
        body: audio,
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const { text } = (await res.json()) as { text: string };
      const transcript = (text ?? '').replace(/\u0000/g, '').trim();
      await this.sql.begin(async (tx) => {
        await tx`
          UPDATE media SET transcript = ${transcript}, transcribed_at = now(), transcribe_error = NULL,
            transcribe_attempts = transcribe_attempts + 1
          WHERE message_id = ${row.message_id}`;
        // voice notes have no text of their own; keep a caption if there ever is one
        await tx`UPDATE messages SET body = coalesce(body, ${transcript || null}) WHERE id = ${row.message_id}`;
      });
      metrics.transcriptions.inc({ result: 'done' });
    } catch (err: any) {
      const text = String(err?.message ?? err).slice(0, 500);
      await this.sql`
        UPDATE media SET transcribe_attempts = transcribe_attempts + 1, transcribe_error = ${text},
          next_attempt_at = now() + interval '10 minutes' * (transcribe_attempts + 1)
        WHERE message_id = ${row.message_id}`;
      metrics.transcriptions.inc({ result: 'error' });
      this.log.warn({ msgId: row.msg_id, err: text }, 'transcription failed');
    }
  }
}
