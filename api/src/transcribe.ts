// Speech-to-text: passed through to the transcriber, so consumers need only this service.
import type { IncomingMessage } from 'node:http';
import { config } from './config.js';
import { HttpError, MAX_AUDIO, readBody } from './http.js';

export async function transcribe(req: IncomingMessage) {
  if (!config.transcriberUrl) throw new HttpError(503, 'no transcriber configured');
  const audio = await readBody(req, MAX_AUDIO);
  if (audio.length === 0) throw new HttpError(400, 'empty body: send the audio file as the request body');
  const res = await fetch(`${config.transcriberUrl}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' },
    body: audio as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(300_000),
  }).catch((err) => {
    throw new HttpError(502, `transcriber unreachable: ${err?.cause?.code ?? err?.message ?? err}`);
  });
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status === 400 ? 400 : 502, `transcriber: HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}
