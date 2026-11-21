// Providers: the optional, user-level list of OpenAI-compatible chat-completions endpoints (<jefe home>/providers.json).
// The file never holds a key, only the NAME of the environment variable that does. Nothing here touches the network.
import { registryHome } from '../../hooks/approvals-state.mjs';
import { readRegular, safe, writePrivate } from '../../hooks/projects.mjs';
import { scanText } from '../gate/secrets-scan.mjs';
import { MODEL_RE, NAME_RE } from './rules.mjs';

export const USES = ['summarise', 'classify', 'extract', 'draft', 'second-opinion'];
export const MAX_MODELS = 8;
export { MODEL_RE, NAME_RE };
export const KEY_ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
// The key variable of a provider is sent to ITS host, so it is an allow rule, not a denylist:
//  - a BUILT-IN shortcut (today only `openrouter`) uses its well-known variable (OPENROUTER_API_KEY) and is pinned to its own host (validateProvider);
//  - EVERY other provider's key variable must start with JEFE_PROVIDER_ (default JEFE_PROVIDER_<NAME>_KEY, the name upper-cased, dashes as underscores).
// <NAME>_API_KEY (ANTHROPIC_API_KEY, ...) is never accepted for a custom provider: it would send a real service's key to whatever host was typed.
// (JEFE_TEST_ only with the tests' knob below.)
export const KEY_PREFIX = 'JEFE_PROVIDER_';
export const keyEnvFor = (name) => (isBuiltin(name) ? BUILTIN[name].keyEnv : `${KEY_PREFIX}${String(name).toUpperCase().replace(/-/g, '_')}_KEY`);
export const keyEnvAllowed = (name, keyEnv) => (isBuiltin(name) ? keyEnv === BUILTIN[name].keyEnv : keyEnv.startsWith(KEY_PREFIX) || (allowLocal() && keyEnv.startsWith('JEFE_TEST_')));
// Tests only: JEFE_PROVIDERS_ALLOW_LOCAL=1 allows http://127.0.0.1 and localhost (the fake server) and ONLY for a key variable named JEFE_TEST_*, so a real key never goes in clear. Never set outside tests.
const allowLocal = () => process.env.JEFE_PROVIDERS_ALLOW_LOCAL === '1';

// The one built-in shortcut (`provider add openrouter`): it fixes its own host and key variable (--base-url and --key-env are refused for it). Free model ids age:
// check https://openrouter.ai/models?q=free and refresh the list with `provider add openrouter --model <id> --model <id>`: on an existing entry that needs no --replace
// while the host and key variable stay the same (only models, uses, trusted or paid change). A different host or key variable needs --replace.
export const OPENROUTER = {
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  keyEnv: 'OPENROUTER_API_KEY',
  models: ['inclusionai/ling-3.2-flash:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free'],
  uses: [...USES],
  trusted: false,
  paid: false,
};

// The fields a job's approval records and `ask` compares (anything that changes where the key goes or what may be sent).
const BUILTIN = { openrouter: OPENROUTER };
function isBuiltin(name) {
  return Object.prototype.hasOwnProperty.call(BUILTIN, name);
}

export const record = (p) => ({ name: p.name, baseUrl: p.baseUrl, keyEnv: p.keyEnv, models: p.models, uses: p.uses, trusted: p.trusted, paid: p.paid === true });

// The registry home is THE validated one (hooks/approvals-state.mjs registryHome: JEFE_HOME only when absolute, resolvable and not inside the project `root`);
// providers.json and its lock live in it, never at a path built from JEFE_HOME here. Throws when no registry folder is usable (fail closed).
export function providerHome(root = null) {
  const h = registryHome(root);
  if (h === null) throw new Error('no usable Jefe registry folder');
  return h;
}
export const providersFile = (root = null) => `${providerHome(root)}/providers.json`;

const BAD_SUFFIX = /\.(localhost|local|internal|lan)$/;
// Normalises a base URL BEFORE any comparison or storage: host lower-cased, one trailing dot dropped, default port dropped, origin + path with no trailing slash.
// -> { ok: true, url, host } | { ok: false, error }. keyEnv: only for the tests' local-server exception.
export function checkBaseUrl(u, keyEnv = '') {
  const raw = String(u);
  if (raw.includes('?') || raw.includes('#')) return { ok: false, error: 'base URL must not contain a query or a fragment' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'base URL is not a valid URL' };
  }
  if (url.username || url.password || /@/.test(raw.split('//')[1]?.split('/')[0] || '')) return { ok: false, error: 'base URL must not contain a login' };
  const h = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname.replace(/\/+$/, '');
  const local = (h === '127.0.0.1' || h === 'localhost') && url.protocol === 'http:';
  if (local && allowLocal() && String(keyEnv).startsWith('JEFE_TEST_')) return { ok: true, url: `http://${h}${url.port ? ':' + url.port : ''}${path}`, host: `${h}${url.port ? ':' + url.port : ''}` };
  if (url.protocol !== 'https:') return { ok: false, error: 'base URL must be https' };
  if (h.startsWith('[') || /^\d+(\.\d+){0,3}$/.test(h) || /^0x/i.test(h)) return { ok: false, error: 'base URL must use a host name, not an IP address' };
  if (h === 'localhost' || !h.includes('.') || BAD_SUFFIX.test(h)) return { ok: false, error: 'base URL must be a public host name (not localhost, a single-label name, or ending .localhost, .local, .internal, .lan)' };
  const host = url.port ? `${h}:${url.port}` : h; // URL already drops :443 for https
  return { ok: true, url: `https://${host}${path}`, host };
}

// Is this (normalised) provider OpenRouter? Its models must end in :free unless the provider was added with --paid.
export const isOpenRouter = (p) => {
  try {
    const h = new URL(p.baseUrl).hostname.toLowerCase().replace(/\.$/, '');
    return h === 'openrouter.ai' || h.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
};
// -> the models that may cost money and were not allowed with --paid (empty when none)
export const paidModels = (p, models = p.models) => (isOpenRouter(p) && p.paid !== true ? models.filter((m) => !m.endsWith(':free')) : []);

export const hostOf = (p) => {
  try {
    return new URL(p.baseUrl).host;
  } catch {
    return '?';
  }
};

// -> { ok: true, provider } (normalised) | { ok: false, error }
export function validateProvider(p, { scan = true } = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'provider is not an object' };
  if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) return { ok: false, error: 'name must be lowercase letters, digits and hyphens, starting with a letter or digit, at most 40' };
  const b = checkBaseUrl(p.baseUrl, p.keyEnv);
  if (!b.ok) return b;
  if (isBuiltin(p.name) && b.url !== checkBaseUrl(BUILTIN[p.name].baseUrl).url) return { ok: false, error: `provider ${p.name} is a built-in shortcut pinned to ${hostOf(BUILTIN[p.name])}; use another name for another host` };
  if (typeof p.keyEnv === 'string' && KEY_ENV_RE.test(p.keyEnv) && !keyEnvAllowed(p.name, p.keyEnv)) {
    return { ok: false, error: isBuiltin(p.name) ? `key variable of ${p.name} must be exactly ${BUILTIN[p.name].keyEnv}` : `key variable must start with ${KEY_PREFIX} (default ${keyEnvFor(p.name)}); a <NAME>_API_KEY variable is not accepted for a custom provider` };
  }
  // a name that looks like a key (the scan always runs: go, ask, start, provider list and provider add all load providers the same way)
  if (typeof p.keyEnv !== 'string' || !KEY_ENV_RE.test(p.keyEnv) || (scan && scanText('x.txt', p.keyEnv, Date.now() + 1000).hits.length)) {
    return { ok: false, error: 'key variable must be the NAME of an environment variable (UPPER_CASE letters, digits, underscore), never the key itself' };
  }
  if (!Array.isArray(p.models) || !p.models.length || p.models.length > MAX_MODELS || !p.models.every((m) => typeof m === 'string' && MODEL_RE.test(m))) {
    return { ok: false, error: `give 1 to ${MAX_MODELS} model ids (letters, digits and . _ : / @ + -)` };
  }
  const uses = p.uses === undefined ? [...USES] : p.uses;
  if (!Array.isArray(uses) || !uses.length || !uses.every((u) => USES.includes(u))) return { ok: false, error: `uses must be from: ${USES.join(', ')}` };
  const provider = { name: p.name, baseUrl: b.url, keyEnv: p.keyEnv, models: [...new Set(p.models)], uses: [...new Set(uses)], trusted: p.trusted === true, ...(p.paid === true ? { paid: true } : {}) };
  const costly = paidModels(provider);
  if (costly.length) return { ok: false, error: `${costly.join(', ')} is not a :free model and may cost money on openrouter.ai; add the provider with --paid to allow it` };
  return { ok: true, provider };
}

// -> { providers: [valid provider], problems: [text] } ; a missing file is no providers, a broken one is reported and ignored; entries that break a rule are listed in problems and never usable. One call shape everywhere (go, ask, start, provider list) (never overwritten here)
export function loadProviders({ scan = true, root = null } = {}) {
  let text;
  try {
    text = readRegular(providersFile(root), 256 * 1024);
  } catch {
    return { providers: [], problems: ['no usable Jefe registry folder'] };
  }
  if (text === null) return { providers: [], problems: [] };
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { providers: [], problems: ['providers.json is not valid JSON'] };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.providers)) return { providers: [], problems: ['providers.json has no "providers" list'] };
  const list = j.providers;
  const providers = [];
  const problems = [];
  for (const raw of list) {
    const v = validateProvider(raw, { scan });
    // the rule `provider add` enforces, enforced at load too (a hand-edited file): two providers with different hosts never share a key variable; the later entry is ignored
    const clash = v.ok ? providers.find((q) => q.keyEnv === v.provider.keyEnv && hostOf(q) !== hostOf(v.provider)) : null;
    if (v.ok && !providers.some((q) => q.name === v.provider.name) && !clash) providers.push(v.provider);
    else problems.push(`${safe(String(raw && raw.name).slice(0, 40))}: ${v.ok ? (clash ? `key variable ${v.provider.keyEnv} is already used by provider ${clash.name} (host ${hostOf(clash)}); it would send that key to ${hostOf(v.provider)}` : 'duplicate name') : v.error}`);
  }
  return { providers, problems };
}

export function saveProviders(providers, root = null) {
  writePrivate(providersFile(root), JSON.stringify({ providers }, null, 2) + '\n', { guardDir: true });
}

// Providers that are configured AND whose key variable is set (the `providers:` line of start).
export const usable = (root = null, env = process.env) => loadProviders({ root }).providers.filter((p) => typeof env[p.keyEnv] === 'string' && env[p.keyEnv].length > 0);
