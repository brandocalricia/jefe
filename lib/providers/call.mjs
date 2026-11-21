// The ONE file in the plugin that talks to the network: one chat-completions request, nothing else.
// Node's built-in fetch, JSON body, no shell, no curl. Redirects are never followed. The key goes only into the Authorization header
// and is never returned, printed or logged. Only the single user message passed in is sent.

// Environment that changes where the key could go or how it is protected. NODE_TLS_REJECT_UNAUTHORIZED=0 refuses the send; proxy and CA variables only get a note (names only).
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_USE_SYSTEM_CA'];
export const tlsOff = (env = process.env) => env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
export function envNotes(env = process.env) {
  const set = PROXY_VARS.filter((n) => (typeof env[n] === 'string' && env[n] !== '') || (typeof env[n.toLowerCase()] === 'string' && env[n.toLowerCase()] !== ''));
  const flag = typeof env.NODE_OPTIONS === 'string' ? /(?:^|[\s"'])(--use-(?:openssl|system)-ca)(?=$|[\s"'=])/.exec(env.NODE_OPTIONS) : null;
  if (flag) set.push(`NODE_OPTIONS (${flag[1]})`);
  return set.length ? [`note: ${set.join(', ')} set: the request may go through a proxy or an extra certificate authority`] : [];
}

// Control, bidi, zero-width and other invisible characters a provider's answer loses before it is printed.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u00ad\u061c\u180e\u2060-\u2064\u2066-\u2069\u206a-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// A provider's answer made safe to print: line ends unified, invisible characters stripped FIRST, then the key replaced with [key]
// (in this order, so a key split by an invisible character cannot come back together after the replacement), then trimmed.
export function cleanAnswer(text, key) {
  let t = String(text).replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
  for (const k of new Set([key, String(key).replace(INVISIBLE, '')])) if (k) t = t.split(k).join('[key]');
  return t.trim();
}

const MAX_BODY = 2 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request. -> { ok: true, text } | { ok: false, kind: 'rate'|'server'|'timeout'|'network'|'auth'|'bad'|'redirect'|'empty', status? }
async function once(p, key, model, prompt, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const s = res.status;
    if (s >= 300 && s < 400) return { ok: false, kind: 'redirect', status: s };
    if (s === 429) return { ok: false, kind: 'rate', status: s };
    if (s >= 500) return { ok: false, kind: 'server', status: s };
    if (s === 401 || s === 402 || s === 403) return { ok: false, kind: 'auth', status: s };
    if (!res.ok) return { ok: false, kind: 'bad', status: s };
    let body = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      body += dec.decode(chunk, { stream: true });
      if (body.length > MAX_BODY) return { ok: false, kind: 'bad', status: s };
    }
    let content;
    try {
      content = JSON.parse(body).choices[0].message.content;
    } catch {
      return { ok: false, kind: 'bad', status: s };
    }
    if (Array.isArray(content)) content = content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('');
    return typeof content === 'string' && content.trim() ? { ok: true, text: content } : { ok: false, kind: 'empty', status: s };
  } catch (err) {
    return { ok: false, kind: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Tries the provider's models in order (or only `only`) inside ONE overall deadline (overallMs, all attempts and waits together; each
// attempt gets a third of it at most). A 429 moves to the next model; a 5xx, a timeout or a network error gets ONE retry after retryMs,
// then moves on; 404-like bad answers and empty answers move on; auth errors and redirects stop at once.
// -> { ok: true, text, model, ms } | { ok: false, kind, status?, tried: [model] }
export async function callProvider(p, key, prompt, { only = null, overallMs = 90000, retryMs = 1000 } = {}) {
  if (tlsOff()) return { ok: false, kind: 'tls-env', tried: [], ms: 0 };
  const t0 = Date.now();
  const left = () => overallMs - (Date.now() - t0);
  const models = only ? [only] : p.models;
  const tried = [];
  let last = { kind: 'timeout' };
  for (const model of models) {
    if (left() <= 0) break;
    tried.push(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (left() <= 0) return { ok: false, ...last, kind: 'timeout', tried, ms: Date.now() - t0 };
      const r = await once(p, key, model, prompt, Math.max(1, Math.min(left(), overallMs / 3)));
      if (r.ok) return { ok: true, text: r.text, model, ms: Date.now() - t0 };
      last = r;
      if (r.kind === 'auth' || r.kind === 'redirect') return { ok: false, ...r, tried, ms: Date.now() - t0 };
      if ((r.kind === 'server' || r.kind === 'timeout' || r.kind === 'network') && attempt === 0) {
        await sleep(Math.min(retryMs, Math.max(0, left())));
        continue;
      }
      break;
    }
  }
  return { ok: false, ...last, ...(left() <= 0 ? { kind: 'timeout' } : {}), tried, ms: Date.now() - t0 };
}
