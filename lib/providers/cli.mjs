// `jefe-project provider add|list|remove|test`: manage <jefe home>/providers.json (never holds a key; see docs/PROVIDERS.md).
import { findRoot, hasJefe, unattended } from '../../hooks/permit-core.mjs';
import { safe, withLock } from '../../hooks/projects.mjs';
import { callProvider, cleanAnswer, envNotes } from './call.mjs';
import { NAME_RE } from './rules.mjs';
import { hostOf, keyEnvFor, loadProviders, OPENROUTER, providerHome, providersFile, saveProviders, USES, validateProvider } from './config.mjs';

// The project the command is run in, if any (the root has a real .jefe): the registry home must not be inside it (config.mjs providerHome).
// findRoot names a folder for any cwd, so a folder that is no project yet is null here, as the gate sees it.
const rootNow = () => {
  const r = findRoot(process.cwd());
  return r !== null && hasJefe(r) ? r : null;
};

const usage = (m) => ({ lines: [`jefe-project: ${m}`], code: 2 });
const ADD_USAGE = 'usage: provider add <name> --base-url <url> [--key-env <VAR>] --model <id> [--model <id>]... [--use <kind>]... [--trusted] [--paid] [--replace]  |  provider add openrouter [--model <id>]...\n(the key variable must start with JEFE_PROVIDER_; default JEFE_PROVIDER_<NAME>_KEY, the name upper-cased with dashes as underscores. Only the built-in openrouter uses OPENROUTER_API_KEY, and only for its own host.\nAn existing provider with the same host and key variable is updated (models, uses, trusted, paid) without --replace; a different host or key variable needs --replace.)'

// -> { lines, code }
export async function cmdProvider(args, env = process.env) {
  const [sub, ...rest] = args;
  // management is an interactive, user-present action: it changes where a key goes (or sends one)
  if ((sub === 'add' || sub === 'remove' || sub === 'test') && unattended(env)) return usage(`provider ${sub} does not run in an unattended (headless) session; run it yourself in a terminal`);
  if (sub === 'add') return add(rest);
  if (sub === 'list') return list();
  if (sub === 'remove' || sub === 'test') {
    if (rest.length !== 1) return usage(`usage: provider ${sub} <name>`);
    return sub === 'remove' ? remove(rest[0]) : test(rest[0]);
  }
  return usage('usage: provider add|list|remove|test ...');
}

function add(args) {
  const name = args[0];
  if (!name || name.startsWith('-')) return usage(ADD_USAGE);
  const base = name === 'openrouter' ? OPENROUTER : { name, baseUrl: undefined, keyEnv: undefined, models: [], uses: [...USES], trusted: false };
  const o = { ...base, models: [...base.models], uses: [...base.uses] };
  const typed = { baseUrl: false, keyEnv: false };
  const models = [];
  const uses = [];
  let paid = false;
  let replace = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--trusted') o.trusted = true;
    else if (a === '--paid') paid = true;
    else if (a === '--replace') replace = true;
    else if (a === '--base-url' || a === '--key-env' || a === '--model' || a === '--use') {
      if (i + 1 >= args.length) return usage(`${a} needs a value\n${ADD_USAGE}`);
      const v = args[++i];
      if (a === '--base-url') (o.baseUrl = v, (typed.baseUrl = true));
      else if (a === '--key-env') (o.keyEnv = v, (typed.keyEnv = true));
      else if (a === '--model') models.push(v);
      else uses.push(v);
    } else return usage(`unknown argument ${safe(a.slice(0, 60))}\n${ADD_USAGE}`);
  }
  // the built-in shortcut fixes its own host and key variable: it can never be pointed elsewhere with the seeded key
  if (name === 'openrouter' && (typed.baseUrl || typed.keyEnv)) return usage(`provider openrouter is a built-in shortcut: --base-url and --key-env are not accepted (use another name for another host)\n${ADD_USAGE}`);
  if (name !== 'openrouter' && o.keyEnv === undefined && NAME_RE.test(name)) o.keyEnv = keyEnvFor(name);
  if (paid) o.paid = true;
  if (models.length) o.models = models;
  if (uses.length) o.uses = uses;
  const v = validateProvider(o);
  if (!v.ok) return usage(`${v.error}\n${ADD_USAGE}`);
  const lines = [];
  if (v.provider.trusted) lines.push(`warning: files from your projects will be sent to ${hostOf(v.provider)}`);
  const w = change((cur) => {
    const old = cur.providers.find((p) => p.name === v.provider.name);
    // same host and same key variable: an update (models, uses, trusted, paid) needs no --replace; a changed host or key variable does
    const moved = old && (hostOf(old) !== hostOf(v.provider) || old.keyEnv !== v.provider.keyEnv);
    if (moved && !replace) return { refuse: `provider ${v.provider.name} already exists with host ${hostOf(old)} (key variable ${old.keyEnv}); the new one is host ${hostOf(v.provider)} (key variable ${v.provider.keyEnv}). Add --replace to overwrite it` };
    const clash = cur.providers.find((p) => p.name !== v.provider.name && p.keyEnv === v.provider.keyEnv && hostOf(p) !== hostOf(v.provider));
    if (clash) return { refuse: `key variable ${v.provider.keyEnv} is already used by provider ${clash.name} (host ${hostOf(clash)}); it would send that key to ${hostOf(v.provider)}` };
    const others = cur.providers.filter((p) => p.name !== v.provider.name);
    return { next: [...others, v.provider], note: !old ? 'added' : moved ? 'replaced' : 'updated', old, moved };
  });
  if (w.error) return w.error;
  if (w.refuse) return usage(w.refuse);
  if (w.old && w.moved) lines.push(`replace: ${v.provider.name} host ${hostOf(w.old)} -> ${hostOf(v.provider)}, key variable ${w.old.keyEnv} -> ${v.provider.keyEnv}`);
  if (w.old && !w.moved) {
    const yn = (b) => (b ? 'yes' : 'no');
    const ch = [`models ${w.old.models.length} -> ${v.provider.models.length}`];
    if (w.old.uses.join(',') !== v.provider.uses.join(',')) ch.push(`uses ${w.old.uses.join(',')} -> ${v.provider.uses.join(',')}`);
    if (w.old.trusted !== v.provider.trusted) ch.push(`trusted ${yn(w.old.trusted)} -> ${yn(v.provider.trusted)}`);
    if ((w.old.paid === true) !== (v.provider.paid === true)) ch.push(`paid ${yn(w.old.paid === true)} -> ${yn(v.provider.paid === true)}`);
    lines.push(`updated: ${v.provider.name} ${ch.join(', ')}`);
  }
  lines.push(`provider: ${w.note} ${v.provider.name} (${hostOf(v.provider)}, ${v.provider.models.length} model${v.provider.models.length === 1 ? '' : 's'}, key variable ${v.provider.keyEnv})`);
  return { lines, code: 0 };
}

function list() {
  const { providers, problems } = loadProviders({ root: rootNow() });
  const lines = providers.map((p) => `${p.name}: host=${hostOf(p)} models=${p.models.join(',')} uses=${p.uses.join(',')} trusted=${p.trusted ? 'yes' : 'no'} key=${typeof process.env[p.keyEnv] === 'string' && process.env[p.keyEnv] ? `set (${p.keyEnv})` : `not set (${p.keyEnv})`}`);
  if (!providers.length) lines.push('providers: none configured');
  for (const m of problems) lines.push(`warning: ignored an entry: ${m}`);
  return { lines, code: 0 };
}

function remove(name) {
  const w = change((cur) => (cur.providers.some((p) => p.name === name) ? { next: cur.providers.filter((p) => p.name !== name), note: 'removed' } : { missing: true }));
  if (w.error) return w.error;
  if (w.missing) return { lines: [`jefe-project: no provider named "${safe(name.slice(0, 40))}"`], code: 1 };
  return { lines: [`provider: removed ${name}`], code: 0 };
}

// Read-modify-write of providers.json under the lock the project registry uses. A file with ANY problem is never rewritten
// (a rewrite from the valid entries would silently drop the rest): the problems are printed and nothing changes.
// fn(current) -> { next, note } | { missing } ; -> { note } | { missing } | { error: { lines, code } }
function change(fn) {
  try {
    const root = rootNow();
    return withLock(`${providerHome(root)}/.providers`, () => {
      const cur = loadProviders({ root });
      if (cur.problems.length) return { error: { lines: [`jefe-project: ${providersFile(root)} has problems, so nothing was changed. Fix or remove the file first:`, ...cur.problems.map((m) => `  ${m}`)], code: 1 } };
      const r = fn(cur);
      if (r.next) saveProviders(r.next, root);
      return r;
    });
  } catch (err) {
    return { error: { lines: [`jefe-project: cannot update the providers file: ${safe((err && (err.code || err.message)) || err)}`], code: 1 } };
  }
}

async function test(name) {
  const p = loadProviders({ root: rootNow() }).providers.find((q) => q.name === name);
  if (!p) return { lines: [`jefe-project: no provider named "${safe(name.slice(0, 40))}"`], code: 1 };
  const key = process.env[p.keyEnv];
  if (!key) return { lines: [`test: FAILED the environment variable ${p.keyEnv} is not set; nothing was sent`], code: 1 };
  const r = await callProvider(p, key, 'Reply with the single word ok', { overallMs: 60000 });
  if (!r.ok && r.kind === 'tls-env') return { lines: ['test: FAILED NODE_TLS_REJECT_UNAUTHORIZED=0 is set (certificate checks off); nothing was sent'], code: 1 };
  if (!r.ok) return { lines: [`test: FAILED ${p.name} (contacted ${hostOf(p)}): ${r.kind}${r.status ? ` (HTTP ${r.status})` : ''} (tried ${r.tried.join(', ')}, ${r.ms} ms)`], code: 1 };
  return { lines: [...envNotes(), `test: ok ${p.name} (contacted ${hostOf(p)}) model=${r.model} ms=${r.ms}`, `answer: ${safe(cleanAnswer(r.text, key).slice(0, 40))}`], code: 0 };
}
