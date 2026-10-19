// Baileys auth state in Postgres: credentials plus every Signal key as a row of wa_auth.
// Each set() is one transaction, so a crash can't leave half of a key update on disk
// (the multi-file store writes one file per key with no atomicity).
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from 'baileys';
import type { Sql } from '@alfred/db';

const encode = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const decode = (text: string): any => JSON.parse(text, BufferJSON.reviver);

export async function usePostgresAuthState(sql: Sql) {
  const [row] = await sql<{ value: string }[]>`SELECT value FROM wa_auth WHERE type = 'creds' AND id = ''`;
  const creds: AuthenticationCreds = row ? decode(row.value) : initAuthCreds();

  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      if (ids.length === 0) return result;
      const rows = await sql<{ id: string; value: string }[]>`
        SELECT id, value FROM wa_auth WHERE type = ${type} AND id = ANY(${ids})`;
      for (const r of rows) {
        let value = decode(r.value);
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        result[r.id] = value;
      }
      return result;
    },
    async set(data: SignalDataSet) {
      const upserts: { type: string; id: string; value: string }[] = [];
      const deletes: { type: string; id: string }[] = [];
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value === null || value === undefined) deletes.push({ type, id });
          else upserts.push({ type, id, value: encode(value) });
        }
      }
      if (upserts.length === 0 && deletes.length === 0) return;
      await sql.begin(async (tx) => {
        for (const d of deletes) await tx`DELETE FROM wa_auth WHERE type = ${d.type} AND id = ${d.id}`;
        if (upserts.length > 0) {
          await tx`
            INSERT INTO wa_auth ${tx(upserts, 'type', 'id', 'value')}
            ON CONFLICT (type, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
        }
      });
    },
    async clear() {
      await sql`DELETE FROM wa_auth WHERE type <> 'creds'`;
    },
  };

  const saveCreds = async () => {
    await sql`
      INSERT INTO wa_auth (type, id, value) VALUES ('creds', '', ${encode(creds)})
      ON CONFLICT (type, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  };

  /** Forget the linked device entirely (after a logout): the next start shows a new QR. */
  const reset = async () => {
    await sql`DELETE FROM wa_auth`;
  };

  return { state: { creds, keys }, saveCreds, reset };
}
