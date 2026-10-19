import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  toNumber,
  type CacheStore,
  type WASocket,
} from 'baileys';
import { pino } from 'pino';
import qrcode from 'qrcode-terminal';
import { usePostgresAuthState } from './auth-state.js';
import { config } from './config.js';
import { migrate, sql } from '@alfred/db';
import { Ingest, ignoredJid } from './ingest.js';
import { MediaWorker } from './media.js';
import { Transcriber } from './transcribe.js';
import { metrics, startHttp, status } from './metrics.js';

const log = pino({ level: config.logLevel });

function browser() {
  const [os, name] = config.browser;
  const make = (Browsers as Record<string, (b: string) => [string, string, string]>)[os];
  if (!make || !name) throw new Error(`WA_BROWSER must look like "ubuntu:Desktop", got "${config.browser.join(':')}"`);
  return make(name);
}
const baileysLog = pino({ level: config.baileysLogLevel }).child({ module: 'baileys' });

/** Minimal in-memory CacheStore for Baileys' retry counters. */
class MapCache implements CacheStore {
  private m = new Map<string, unknown>();
  get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  set<T>(key: string, value: T) {
    if (this.m.size > 10_000) this.m.clear();
    this.m.set(key, value);
  }
  del(key: string) {
    this.m.delete(key);
  }
  flushAll() {
    this.m.clear();
  }
}

async function main() {
  await migrate(log);
  const auth = await usePostgresAuthState(sql);
  const ingest = new Ingest(sql, log);
  await ingest.init();
  startHttp(config.httpPort, sql);

  let sock: WASocket | undefined;
  let connected = false;
  let attempt = 0;
  let stopping = false;
  let pairingRequested = false;
  const retryCache = new MapCache();
  const media = new MediaWorker(sql, log.child({ module: 'media' }), () => (connected ? sock : undefined));
  setInterval(() => void media.tick(), 15_000).unref();
  const transcriber = new Transcriber(sql, log.child({ module: 'transcribe' }));
  setInterval(() => void transcriber.tick(), 30_000).unref();

  const setConnection = (state: string) => {
    status.connection = state;
    connected = state === 'open';
    metrics.connected.set(connected ? 1 : 0);
  };

  const connect = async () => {
    setConnection('connecting');
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    ingest.setMe(auth.state.creds.me);
    const s = makeWASocket({
      version,
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLog) },
      logger: baileysLog,
      // A desktop identity is what makes the phone send the full history on first link.
      // macOS/Windows 'Desktop' are refused at registration (428) as of 7.0.0-rc14; Ubuntu is accepted.
      browser: browser(),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      shouldIgnoreJid: (jid) => ignoredJid(jid),
      getMessage: (key) => ingest.loadMessage(key),
      cachedGroupMetadata: async (jid) => ingest.groups.get(jid),
      msgRetryCounterCache: retryCache,
    });
    sock = s;
    pairingRequested = false;

    // ev.process delivers buffered events in order; awaiting the writes is the backpressure.
    s.ev.process(async (events) => {
      try {
        if (events['connection.update']) {
          const { connection, lastDisconnect, qr } = events['connection.update'];
          if (qr) {
            if (config.pairingPhone && !auth.state.creds.registered) {
              if (!pairingRequested) {
                pairingRequested = true;
                const code = await s.requestPairingCode(config.pairingPhone);
                log.warn({ code, browser: config.browser.join(':') }, 'pairing code (valid for this connection only): WhatsApp → Linked devices → Link a device → Link with phone number instead');
              }
            } else {
              qrcode.generate(qr, { small: true }, (art) => console.log(`\n${art}`));
              log.warn('scan the QR above: WhatsApp → Linked devices → Link a device');
            }
            setConnection('waiting_for_pairing');
          }
          if (connection === 'open') {
            attempt = 0;
            setConnection('open');
            ingest.setMe(s.user ? { id: s.user.id, lid: s.user.lid } : auth.state.creds.me);
            log.info({ me: s.user?.id }, 'connected');
            const groups = await s.groupFetchAllParticipating().catch((err) => {
              log.warn({ err }, 'group fetch failed');
              return {};
            });
            await ingest.upsertGroups(Object.values(groups));
            void media.tick();
          }
          if (connection === 'close') {
            const code = (lastDisconnect?.error as any)?.output?.statusCode ?? 0;
            metrics.reconnects.inc({ code: String(code) });
            setConnection('closed');
            if (stopping) return;
            if (code === DisconnectReason.loggedOut) {
              // The device was unlinked from the phone: forget it and restart into a fresh QR.
              setConnection('logged_out');
              log.error('logged out from the phone: clearing the linked device, a new QR follows');
              await auth.reset();
              process.exit(1);
            }
            const delay =
              code === DisconnectReason.restartRequired
                ? 0
                : code === DisconnectReason.connectionReplaced
                  ? 5 * 60_000
                  : Math.min(1000 * 2 ** attempt++, 5 * 60_000);
            log.warn({ code, delay, err: lastDisconnect?.error?.message }, 'connection closed, reconnecting');
            setTimeout(() => void connect().catch(fatal), delay);
          }
        }

        if (events['creds.update']) {
          Object.assign(auth.state.creds, events['creds.update']);
          await auth.saveCreds();
        }

        if (events['lid-mapping.update']) await ingest.addLidMappings([events['lid-mapping.update']]);

        if (events['messaging-history.set']) {
          const h = events['messaging-history.set'];
          await ingest.addLidMappings(h.lidPnMappings ?? []);
          await ingest.upsertContacts(h.contacts);
          await ingest.upsertChats(h.chats);
          const stored = await ingest.storeMessages(h.messages, 'history');
          metrics.historyChunks.inc();
          log.info(
            { syncType: h.syncType, progress: h.progress, isLatest: h.isLatest, chats: h.chats.length, messages: h.messages.length, stored },
            'history chunk',
          );
        }
        if (events['messaging-history.status']) log.info(events['messaging-history.status'], 'history sync status');

        if (events['contacts.upsert']) await ingest.upsertContacts(events['contacts.upsert']);
        if (events['contacts.update']) await ingest.upsertContacts(events['contacts.update']);
        if (events['chats.upsert']) await ingest.upsertChats(events['chats.upsert']);
        if (events['chats.update']) await ingest.upsertChats(events['chats.update']);
        if (events['groups.upsert']) await ingest.upsertGroups(events['groups.upsert']);
        if (events['groups.update']) await ingest.upsertGroups(events['groups.update']);
        if (events['group-participants.update']) await ingest.onParticipants(events['group-participants.update']);

        if (events['messages.upsert']) {
          const { messages, type } = events['messages.upsert'];
          const stored = await ingest.storeMessages(messages, type === 'notify' ? 'live' : 'append');
          if (stored > 0) void media.tick();
        }
        if (events['messages.update']) {
          for (const { key, update } of events['messages.update']) {
            const edited = update.message?.editedMessage?.message;
            if (edited) await ingest.applyEdit(key, edited, update.messageTimestamp ? toNumber(update.messageTimestamp) : null);
            else if (update.messageStubType === 1 /* REVOKE */ && update.message === null) await ingest.applyRevoke(key);
          }
        }
        if (events['messages.reaction']) await ingest.onReactions(events['messages.reaction']);
      } catch (err) {
        // Losing one batch is better than a dead process; the error is logged with the batch type.
        log.error({ err, events: Object.keys(events) }, 'failed to store events');
      }
    });
  };

  const fatal = (err: unknown) => {
    log.fatal({ err }, 'fatal');
    process.exit(1);
  };

  const shutdown = async () => {
    stopping = true;
    log.info('shutting down');
    sock?.end(undefined);
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await connect();
}

main().catch((err) => {
  log.fatal({ err }, 'startup failed');
  process.exit(1);
});
