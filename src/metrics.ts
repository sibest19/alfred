import { createServer } from 'node:http';
import { Counter, Gauge, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { Sql } from './db.js';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const status = {
  /** idle | connecting | waiting_for_pairing | open | closed | logged_out */
  connection: 'idle' as string,
};

export const metrics = {
  connected: new Gauge({ name: 'wa_connected', help: '1 while the WhatsApp connection is open', registers: [registry] }),
  reconnects: new Counter({
    name: 'wa_connection_closes_total',
    help: 'Connection closes, by disconnect reason code',
    labelNames: ['code'],
    registers: [registry],
  }),
  messages: new Counter({
    name: 'wa_messages_ingested_total',
    help: 'Messages newly stored, by source (live, append, history)',
    labelNames: ['source'],
    registers: [registry],
  }),
  decryptFailures: new Counter({
    name: 'wa_decrypt_failures_total',
    help: 'Messages that arrived undecryptable (ciphertext stubs)',
    registers: [registry],
  }),
  lastLive: new Gauge({
    name: 'wa_last_live_message_timestamp_seconds',
    help: 'Send time of the newest message received live',
    registers: [registry],
  }),
  historyChunks: new Counter({
    name: 'wa_history_chunks_total',
    help: 'History sync chunks processed',
    registers: [registry],
  }),
  transcriptions: new Counter({
    name: 'wa_transcriptions_total',
    help: 'Audio transcription attempts, by result',
    labelNames: ['result'],
    registers: [registry],
  }),
  mediaDownloads: new Counter({
    name: 'wa_media_downloads_total',
    help: 'Media download attempts, by result',
    labelNames: ['result'],
    registers: [registry],
  }),
};

export function startHttp(port: number, sql: Sql) {
  new Gauge({
    name: 'wa_media_queue',
    help: 'Media rows by status',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM media GROUP BY status`;
      for (const r of rows) this.set({ status: r.status }, r.n);
    },
  });

  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(await registry.metrics());
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
      return;
    }
    if (req.url === '/health') {
      // Healthy only while connected to WhatsApp: a dead session is the failure that matters.
      const ok = status.connection === 'open';
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connection: status.connection }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
