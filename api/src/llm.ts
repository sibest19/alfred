// An agent's model calls, forwarded to OpenRouter with the prompt-cache breakpoints n8n's model nodes can't set.
// Outside API_TOKEN: the caller's own OpenRouter key passes through, so it reaches OpenRouter only with a key the caller holds.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_JSON, readBody } from './http.js';

const UPSTREAM = 'https://openrouter.ai/api/v1';

type Part = { type: string; text?: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } };
type Message = { role: string; content?: string | Part[] | null };
type Body = { model?: string; messages?: Message[]; provider?: unknown };

/** For Claude: caches the system prompt but its last paragraph (the current time) for an hour, and the conversation up
 * to the latest user message for 5 minutes, which the agent's next call in the same turn repeats. */
export function withCache(body: Body): Body {
  if (!body.model?.startsWith('anthropic/') || !Array.isArray(body.messages)) return body;
  const system = body.messages.find((m) => m.role === 'system');
  if (typeof system?.content === 'string') {
    const text = system.content;
    const cut = text.lastIndexOf('\n\n');
    system.content = [{ type: 'text', text: cut > 0 ? text.slice(0, cut) : text, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    if (cut > 0) system.content.push({ type: 'text', text: text.slice(cut) });
  }
  const user = body.messages.findLast((m) => m.role === 'user');
  if (typeof user?.content === 'string' && user.content) user.content = [{ type: 'text', text: user.content }];
  if (Array.isArray(user?.content) && user.content.length) user.content.at(-1)!.cache_control = { type: 'ephemeral' };
  // Vertex's global endpoint spreads calls across regions and mostly misses the cache; Bedrock keeps it
  body.provider ??= { order: ['amazon-bedrock'] };
  return body;
}

/** Forwards `/openrouter/v1/<path>` and returns the call's token use for the log. */
export async function openrouter(req: IncomingMessage, res: ServerResponse, url: URL) {
  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = (await readBody(req, 4 * MAX_JSON)).toString('utf8');
    try {
      body = JSON.stringify(withCache(JSON.parse(body)));
    } catch {} // not JSON: OpenRouter answers it
  }
  const upstream = await fetch(UPSTREAM + url.pathname.slice('/openrouter/v1'.length) + url.search, {
    method: req.method,
    headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(300_000),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(text);
  try {
    const { model, provider, usage } = JSON.parse(text);
    return { model, provider, prompt: usage?.prompt_tokens, cached: usage?.prompt_tokens_details?.cached_tokens, written: usage?.prompt_tokens_details?.cache_write_tokens };
  } catch {
    return {}; // a stream or an error page
  }
}
