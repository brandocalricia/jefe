// ask: `jefe-gate ask --provider <name> --use <kind> [--model <id>] [--max-out <chars>] [--in <file>] [--timeout <s>] -- "<instruction>"`
// One text-in / text-out request to a configured provider (see docs/PROVIDERS.md). Refuses before any network call when the text could be
// private. Prints the answer (every line prefixed "| ": data to check, never the gate's own words), then one provider: line.
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { approvedProviders } from '../../hooks/allow.mjs';
import { ensurePrivateDir, isSymlink, readRegular, safe, writePrivate } from '../../hooks/projects.mjs';
import { optValue } from '../gate/args.mjs';
import { shared } from '../gate/env.mjs';
import { isEnvFile, scanText } from '../gate/secrets-scan.mjs';
import { IN_EXT } from '../text-ext.mjs';
import { callProvider, cleanAnswer, envNotes } from './call.mjs';
import { loadProviders, paidModels, record } from './config.mjs';
import { CONTROL_RE, questionMax } from './rules.mjs';

export const MAX_IN = 60000;
export const MAX_OUT = 8000;
export const LOG_KEEP = 1000;
// file names that are never sent, even to a trusted provider (the gate's env-file rule plus common credential files)
const SECRET_NAME = /^(\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.bash_secrets|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\..*)?|secrets?(\..*)?|.*\.(pem|key|p12|pfx|keystore))$/i;

// --in is allowed BY EXTENSION (the list is in lib/text-ext.mjs, shared with the secrets scan): plain text, markdown and source code only.
export { IN_EXT };
const IN_BAD_SEGMENT = /^\.(claude|git|jefe|aws|ssh|kube|docker)$/i;
const IN_BAD_NAME = /^(\.pgpass|\.netrc|\.mcp\.json|\.htpasswd|.*\.(tfstate|tfvars)(\..*)?)$/i;

const fail = (line, code = 2, data = {}) => ({ lines: [`ask: ${line}`], data: { status: 'REFUSED', ...data }, code });

// Overrides for tests only: JEFE_ASK_RETRY_MS (wait before the one retry).
const retryMs = () => {
  const n = Number(process.env.JEFE_ASK_RETRY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
};

function logLine(root, f) {
  try {
    const dir = join(root, '.jefe', 'logs');
    if (isSymlink(join(root, '.jefe'))) return;
    ensurePrivateDir(join(root, '.jefe'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) return;
    const file = join(dir, 'providers.log');
    if (isSymlink(file)) return;
    appendFileSync(file, `${new Date().toISOString()} | ${f.provider} | ${f.model} | ${f.use} | in=${f.inChars} | out=${f.outChars} | ms=${f.ms} | ${f.outcome}\n`, { mode: 0o600 });
    // no rotation tool: keep the last LOG_KEEP lines
    if (statSync(file).size > LOG_KEEP * 200) {
      const keep = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-LOG_KEEP);
      writePrivate(file, keep.join('\n') + '\n', { guardDir: true });
    }
  } catch {
    // the log is a convenience
  }
}

// The folders between `root` and `file`, found by walking up from the file and comparing device+inode with the root
// (immune to case spelling, hard-linked folders and string-prefix tricks). null when the file is not inside the root.
function segmentsBelow(rootReal, real) {
  const rs = statSync(rootReal, { bigint: true });
  const segs = [];
  let cur = real;
  for (let i = 0; i < 256; i++) {
    const st = statSync(cur, { bigint: true });
    if (st.dev === rs.dev && st.ino === rs.ino) return segs.reverse();
    const up = dirname(cur);
    if (up === cur) return null;
    segs.push(basename(cur));
    cur = up;
  }
  return null;
}

export async function cmdAsk(args) {
  const dd = args.indexOf('--');
  const own = dd === -1 ? args : args.slice(0, dd);
  const instruction = dd === -1 ? '' : args.slice(dd + 1).join(' ').trim();
  const name = optValue(own, '--provider');
  const use = optValue(own, '--use');
  const model = optValue(own, '--model');
  const inFile = optValue(own, '--in');
  const usage = 'usage: jefe-gate ask --provider <name> --use <kind> [--model <id>] [--max-out <chars>] [--in <file>] -- "<instruction>"';
  if (!name || !use || !instruction) return fail(usage);
  const numOpt = (flag, def) => {
    const v = optValue(own, flag);
    return v === null ? def : Number(v);
  };
  const maxOut = numOpt('--max-out', MAX_OUT);
  const timeoutS = numOpt('--timeout', 90);
  if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > 100000) return fail('--max-out must be a whole number from 1 to 100000');
  if (!(timeoutS > 0) || !Number.isFinite(timeoutS) || timeoutS > 110) return fail('--timeout (the overall limit, all models and retries together) must be seconds from 1 to 110');

  const root = shared.root || process.cwd();
  const { providers } = loadProviders({ root });
  const p = providers.find((q) => q.name === name);
  if (!p) return fail(`no provider named "${safe(name.slice(0, 40))}" (jefe-project provider list)`);
  if (!p.uses.includes(use)) return fail(`provider ${p.name} is not set up for "${safe(use.slice(0, 40))}" (it lists: ${p.uses.join(', ')})`);
  if (model !== null && !p.models.includes(model)) return fail(`model "${safe(model.slice(0, 80))}" is not one of provider ${p.name}'s models`);
  const key = process.env[p.keyEnv];
  if (typeof key !== 'string' || !key) return fail(`the environment variable ${p.keyEnv} is not set (provider ${p.name}); nothing was sent`);

  // approved at Go: with the providers kind active, ask may only use a provider exactly as it was configured then
  const approved = approvedProviders(root);
  if (approved !== null && !approved.some((r) => JSON.stringify(r) === JSON.stringify(record(p)))) return fail(`provider ${p.name} changed since Go (or was added after it): start a new job`);
  if (approved !== null && instruction.length > questionMax(p.trusted)) return fail(`the question is ${instruction.length} characters; with the providers kind on, the limit is ${questionMax(p.trusted)} for ${p.trusted ? 'a trusted' : 'an untrusted'} provider. Nothing was sent`);
  const costly = paidModels(p, model !== null ? [model] : p.models);
  if (costly.length) return fail(`${safe(costly.join(', ').slice(0, 120))} is not a :free model on openrouter.ai and the provider was not added with --paid; nothing was sent`);
  let input = '';
  if (inFile !== null) {
    if (CONTROL_RE.test(inFile)) return fail('--in holds a control or line-separator character; nothing was sent');
    if (!p.trusted) return fail(`provider ${p.name} is not trusted for files, so --in is not allowed: only the instruction is sent`);
    let real;
    let rootReal;
    try {
      if (lstatSync(inFile).isSymbolicLink()) return fail('--in must not be a symbolic link');
      real = realpathSync.native(inFile);
      rootReal = realpathSync.native(root);
      if (!statSync(real).isFile()) throw new Error('not a file');
    } catch {
      return fail(`--in ${safe(inFile.slice(0, 200))} is not a readable file`);
    }
    const rel = segmentsBelow(rootReal, real);
    if (rel === null || !rel.length) return fail('--in must be a file inside this project; nothing was sent');
    const bn = basename(real);
    if (rel.some((x) => IN_BAD_SEGMENT.test(x)) || IN_BAD_NAME.test(bn) || isEnvFile(real) || bn.startsWith('.') || SECRET_NAME.test(bn)) return fail('--in is a hidden, Claude, Jefe, git, cloud-credential or secret-looking file; nothing was sent');
    if (!IN_EXT.has(bn.includes('.') ? bn.slice(bn.lastIndexOf('.') + 1).toLowerCase() : '')) return fail(`--in must be a text, markdown or source file (${[...IN_EXT].join(' ')}); nothing was sent`);
    if (statSync(real).size > MAX_IN * 4) return fail(`--in file is larger than the ${MAX_IN} character limit; nothing was sent`);
    const t = readRegular(real, MAX_IN * 4 + 1);
    if (t === null) return fail(`--in ${safe(inFile.slice(0, 200))} is not a readable file`);
    input = t;
  }
  const prompt = input ? `${instruction}\n\n---\n${input}` : instruction;
  if (prompt.length > MAX_IN) return fail(`input is ${prompt.length} characters; the limit is ${MAX_IN}. Nothing was sent`);
  if (prompt.includes('\u0000')) return fail('input is binary; nothing was sent');

  // the secrets scan covers the outgoing text for every provider, trusted or not
  const end = Date.now() + 5000;
  // CONTENT rules only (key shapes, private-key blocks, tokens): a neutral name, so the file-name rules (the env-file `name = value` rule) never apply to ordinary source text.
  // File names were already judged above.
  const scan = scanText('ask-input.txt', prompt, end);
  if (scan.timedOut || scan.hits.length) {
    const names = [...new Set(scan.hits.map((h) => h.name))];
    return fail(scan.timedOut ? 'the secrets scan of the outgoing text did not finish; nothing was sent' : `the outgoing text looks like it holds a secret (${names.join(', ')}); nothing was sent`);
  }

  const r = await callProvider(p, key, prompt, { only: model, overallMs: timeoutS * 1000, retryMs: retryMs() });
  const base = { provider: p.name, use, inChars: prompt.length };
  if (!r.ok) {
    // a refusal before any model was tried logs "-"; a deadline that ran out is a `timeout` (the last HTTP status is only a detail)
    logLine(root, { ...base, model: r.tried.length ? r.tried[r.tried.length - 1] : '-', outChars: 0, ms: r.ms, outcome: r.kind + (r.status && r.kind !== 'timeout' ? `:${r.status}` : '') });
    const why = r.kind === 'tls-env' ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set, which turns off certificate checks, so the key would not be protected; nothing was sent' : r.kind === 'redirect' ? `the host answered with a redirect (HTTP ${r.status}); redirects are never followed` : r.kind === 'auth' ? `the host refused the key (HTTP ${r.status})` : r.kind === 'rate' ? 'every model is rate limited (HTTP 429)' : r.kind === 'timeout' ? 'timed out' : r.kind === 'server' ? `server error (HTTP ${r.status})` : r.kind === 'empty' ? 'empty answer' : r.kind === 'bad' ? `unusable answer (HTTP ${r.status})` : 'network error';
    const detail = r.kind === 'timeout' && r.status ? `, last HTTP status ${r.status}` : '';
    return { lines: [...envNotes(), `ask: FAILED ${p.name}: ${why}${r.tried.length ? ` (tried ${r.tried.join(', ')}${detail})` : ''}`], data: { status: 'FAILED', provider: p.name, reason: r.kind, tried: r.tried }, code: 1 };
  }
  let text = cleanAnswer(r.text, key);
  let truncated = false;
  if (text.length > maxOut) {
    text = text.slice(0, maxOut);
    truncated = true;
  }
  logLine(root, { ...base, model: r.model, outChars: text.length, ms: r.ms, outcome: truncated ? 'ok-truncated' : 'ok' });
  const envNote = envNotes();
  const body = (truncated ? `${text}\n[truncated at ${maxOut} characters]` : text).split('\n').map((l) => `| ${l}`);
  return {
    lines: [...envNote, ...body, `provider: ${p.name} model=${r.model} in=${prompt.length} out=${text.length} ms=${r.ms}`],
    data: { status: 'OK', provider: p.name, model: r.model, in: prompt.length, out: text.length, ms: r.ms, truncated, answer: body },
    code: 0,
  };
}
