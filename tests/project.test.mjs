import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'jefe-test-'));

function pp(args, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('registry: two hosts give different paths for the same name, each writes only its own file', () => {
  const home = tmp();
  const projects = tmp();
  const base = { JEFE_HOME: home, JEFE_PROJECTS_DIR: projects };
  const a = tmp();
  const b = tmp();
  assert.equal(pp(['register', 'demo', a], { ...base, JEFE_HOST: 'hostA' }).code, 0);
  assert.equal(pp(['register', 'demo', b], { ...base, JEFE_HOST: 'hostB' }).code, 0);
  const ra = JSON.parse(pp(['resolve', 'demo'], { ...base, JEFE_HOST: 'hostA' }).out);
  const rb = JSON.parse(pp(['resolve', 'demo'], { ...base, JEFE_HOST: 'hostB' }).out);
  assert.equal(ra.path, a);
  assert.equal(rb.path, b);
  assert.notEqual(ra.path, rb.path);
  assert.equal(ra.handoff, join(a, '.jefe', 'handoff.md'));
  assert.deepEqual(readdirSync(join(home, 'hosts')).sort(), ['hostA.json', 'hostB.json']);
  assert.ok(existsSync(join(home, 'projects.json')));
});

test('resolve falls back to ~/projects/<name>, else fails clearly, --create registers', () => {
  const home = tmp();
  const projects = tmp();
  const env = { JEFE_HOME: home, JEFE_PROJECTS_DIR: projects, JEFE_HOST: 'h1' };
  mkdirSync(join(projects, 'existing'));
  const hit = JSON.parse(pp(['resolve', 'existing'], env).out);
  assert.equal(hit.path, join(projects, 'existing'));
  assert.equal(hit.exists, true);

  const miss = pp(['resolve', 'ghost'], env);
  assert.notEqual(miss.code, 0);
  assert.match(miss.err, /not found/);
  assert.ok(!existsSync(join(projects, 'ghost')));

  const made = JSON.parse(pp(['resolve', 'ghost', '--create'], env).out);
  assert.equal(made.path, join(projects, 'ghost'));
  assert.ok(existsSync(join(projects, 'ghost', '.jefe')));
  const reg = JSON.parse(readFileSync(join(home, 'hosts', 'h1.json'), 'utf8'));
  assert.equal(reg.ghost, join(projects, 'ghost'));
  const list = JSON.parse(pp(['list'], env).out);
  assert.ok(list.projects.some((p) => p.name === 'ghost'));
});

test('aliases in projects.json resolve to the canonical name', () => {
  const home = tmp();
  const proj = tmp();
  const env = { JEFE_HOME: home, JEFE_PROJECTS_DIR: tmp(), JEFE_HOST: 'h1' };
  pp(['register', 'long-name', proj], env);
  writeFileSync(join(home, 'projects.json'), JSON.stringify({ projects: { 'long-name': { aliases: ['ln'] } } }));
  assert.equal(JSON.parse(pp(['resolve', 'ln'], env).out).name, 'long-name');
});

const HEAD = ['Goal', 'DONE WHEN (state)', 'Last done', 'Next', 'Open decisions', 'Key paths'];
function handoff(extraWords = 0, { gate = false, skip = null } = {}) {
  const body = HEAD.filter((h) => h !== skip).map((h) => `## ${h}\nword`).join('\n\n');
  const gateLine = gate ? '\n\nGate: small PASS 2026-11-17 3/3 unverified: none' : '';
  const pad = extraWords ? '\n\n' + Array(extraWords).fill('x').join(' ') : '';
  return body + gateLine + pad + '\n';
}
const words = (t) => t.split(/\s+/).filter(Boolean).length;

test('handoff-check: valid file passes, with or without a Gate line', () => {
  const dir = tmp();
  const plain = join(dir, 'a.md');
  const gated = join(dir, 'b.md');
  writeFileSync(plain, handoff());
  writeFileSync(gated, handoff(0, { gate: true }));
  assert.equal(pp(['handoff-check', plain], {}).code, 0);
  assert.equal(pp(['handoff-check', gated], {}).code, 0);
});

test('handoff-check: 350 words passes, 351 fails; missing heading fails', () => {
  const dir = tmp();
  const base = words(handoff());
  const ok = handoff(350 - base);
  const over = handoff(351 - base);
  assert.equal(words(ok), 350);
  assert.equal(words(over), 351);
  const f1 = join(dir, 'ok.md');
  const f2 = join(dir, 'over.md');
  const f3 = join(dir, 'missing.md');
  writeFileSync(f1, ok);
  writeFileSync(f2, over);
  writeFileSync(f3, handoff(0, { skip: 'Next' }));
  assert.equal(pp(['handoff-check', f1], {}).code, 0);
  const r2 = pp(['handoff-check', f2], {});
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /351 words/);
  const r3 = pp(['handoff-check', f3], {});
  assert.notEqual(r3.code, 0);
  assert.match(r3.err, /missing heading "Next"/);
});

test('the handoff the gate writes passes handoff-check, and the same file without a heading fails with the heading named', () => {
  const d = tmp();
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(d, 'a.txt'), 'x\n');
  git('add', '.');
  git('-c', 'user.email=a@b', '-c', 'user.name=x', 'commit', '-qm', 'i');
  const GATE = fileURLToPath(new URL('../bin/jefe-gate', import.meta.url));
  const g = spawnSync(process.execPath, [GATE, 'finish', '--since', 'start', '--', 'node', '-e', '0'], { cwd: d, encoding: 'utf8', env: { ...process.env, JEFE_HOME: tmp(), JEFE_HOST: 'h1', JEFE_MODE: 'headless', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: undefined } });
  const r = { out: g.stdout };
  assert.match(r.out, /^handoff: ok: \d+ words, all headings present/m, r.out);
  const f = join(d, '.jefe', 'handoff.md');
  assert.equal(pp(['handoff-check', f], {}).code, 0);
  const cut = join(tmp(), 'cut.md');
  writeFileSync(cut, readFileSync(f, 'utf8').replace(/^## Next$/m, '## Later'));
  const bad = pp(['handoff-check', cut], {});
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /missing heading "Next"/);
});

test('project.md and SKILL.md name no handoff shape file the planner cannot resolve', () => {
  const md = readFileSync(fileURLToPath(new URL('../skills/jefe/project.md', import.meta.url)), 'utf8');
  assert.ok(!/docs\/HANDOFF\.md|handoff-template/.test(md));
  assert.ok(md.includes('names each `missing heading "<h>"`'));
});

const envFor = () => ({ JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp(), JEFE_HOST: 'h1' });

test('names are validated on every subcommand that takes one', () => {
  const env = envFor();
  for (const bad of ['../x', '/abs/path', 'has space', '.hidden', 'a/b', '', '-x', 'a..b']) {
    for (const args of [['resolve', bad], ['resolve', bad, '--create'], ['register', bad, '/tmp']]) {
      if (bad === '' && args[0] === 'resolve') continue; // empty is a usage error, still non-zero
      const r = pp(args, env);
      assert.notEqual(r.code, 0, `${args.join(' ')} should fail`);
    }
  }
  assert.deepEqual(readdirSync(env.JEFE_PROJECTS_DIR), []); // nothing was created
  assert.equal(pp(['resolve', 'ok.name_1-x', '--create'], env).code, 0);
});

test('resolve ../x --create exits non-zero and creates nothing outside', () => {
  const env = envFor();
  const r = pp(['resolve', '../x', '--create'], env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /invalid project name/);
  assert.equal(existsSync(join(env.JEFE_PROJECTS_DIR, '..', 'x')), false);
});

test('corrupt registry JSON is copied aside, never overwritten, exit non-zero', () => {
  const env = envFor();
  mkdirSync(env.JEFE_HOME, { recursive: true });
  const reg = join(env.JEFE_HOME, 'projects.json');
  writeFileSync(reg, '{ not json');
  const r = pp(['register', 'demo', tmp()], env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not valid JSON/);
  assert.equal(readFileSync(reg, 'utf8'), '{ not json'); // untouched
  const copies = readdirSync(env.JEFE_HOME).filter((f) => f.startsWith('projects.json.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(env.JEFE_HOME, copies[0]), 'utf8'), '{ not json');
});

test('corrupt host file is also protected', () => {
  const env = envFor();
  mkdirSync(join(env.JEFE_HOME, 'hosts'), { recursive: true });
  const hf = join(env.JEFE_HOME, 'hosts', 'h1.json');
  writeFileSync(hf, '[1,2');
  assert.notEqual(pp(['list'], env).code, 0);
  assert.equal(readFileSync(hf, 'utf8'), '[1,2');
});

test('writes are atomic: no temp files are left behind', () => {
  const env = envFor();
  pp(['register', 'demo', tmp()], env);
  const files = [...readdirSync(env.JEFE_HOME), ...readdirSync(join(env.JEFE_HOME, 'hosts'))];
  assert.ok(files.every((f) => !f.endsWith('.tmp')), files.join(','));
});

test('--create writes .jefe/.gitignore containing *', () => {
  const env = envFor();
  const r = JSON.parse(pp(['resolve', 'newproj', '--create'], env).out);
  assert.equal(readFileSync(join(r.path, '.jefe', '.gitignore'), 'utf8'), '*\n');
});

test('init <path> creates .jefe/ with .gitignore for an existing folder, keeps an existing one', () => {
  const env = envFor();
  const dir = tmp();
  const r = pp(['init', dir], env);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dir, '.jefe', '.gitignore'), 'utf8'), '*\n');
  writeFileSync(join(dir, '.jefe', '.gitignore'), '*\n!handoff.md\n');
  assert.equal(pp(['init', dir], env).code, 0);
  assert.equal(readFileSync(join(dir, '.jefe', '.gitignore'), 'utf8'), '*\n!handoff.md\n');
  assert.notEqual(pp(['init', join(dir, 'missing')], env).code, 0);
});

test('init with no path works in the current folder and reports the folder name as a valid project name', () => {
  const env = envFor();
  const parent = tmp();
  const dir = join(parent, 'My Cool_Project!');
  mkdirSync(dir);
  const r = spawnSync(process.execPath, [BIN, 'init'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, 'my-cool-project');
  assert.equal(j.path, realpathSync(dir));
  assert.ok(existsSync(join(dir, '.jefe', '.gitignore')));
  assert.equal(JSON.parse(pp(['init', dir], env).out).name, 'my-cool-project');
});

test('.jefe/ stays out of git status', () => {
  const env = envFor();
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  pp(['init', dir], env);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
});

// ---- --create guard, --force-new, here ----

function inFolder(cwd, args, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('resolve --create inside an unregistered Jefe project refuses with exit 3 and creates nothing', () => {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp(), JEFE_HOST: 'h1' };
  const cur = tmp();
  mkdirSync(join(cur, '.jefe'));
  const sub = join(cur, 'deep');
  mkdirSync(sub);
  const r = inFolder(sub, ['resolve', 'newthing', '--create'], env);
  assert.equal(r.code, 3);
  assert.equal(r.err.trim().split('\n').length, 1);
  assert.match(r.err, /^current folder already is a Jefe project \(.+\); use: jefe-project register <name> <path>$/m);
  assert.ok(r.err.includes(realpathSync(cur)));
  assert.deepEqual(readdirSync(env.JEFE_PROJECTS_DIR), []);
  assert.ok(!existsSync(join(env.JEFE_HOME, 'hosts')));
});

test('resolve --create inside a registered Jefe project points to resolve by name', () => {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp(), JEFE_HOST: 'h1' };
  const cur = tmp();
  assert.equal(pp(['register', 'mine', cur], env).code, 0);
  mkdirSync(join(cur, '.jefe'));
  const r = inFolder(cur, ['resolve', 'newthing', '--create'], env);
  assert.equal(r.code, 3);
  assert.match(r.err, /already registered as "mine"; use: jefe-project resolve "mine"$/m);
  assert.deepEqual(readdirSync(env.JEFE_PROJECTS_DIR), []);
});

test('--force-new bypasses the guard', () => {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp(), JEFE_HOST: 'h1' };
  const cur = tmp();
  mkdirSync(join(cur, '.jefe'));
  const r = inFolder(cur, ['resolve', 'newthing', '--create', '--force-new'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).path, join(env.JEFE_PROJECTS_DIR, 'newthing'));
  assert.ok(existsSync(join(env.JEFE_PROJECTS_DIR, 'newthing', '.jefe')));
});

test('here: reports path, name and handoff, searching parents; nulls elsewhere; exit 0', () => {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp(), JEFE_HOST: 'h1' };
  const cur = tmp();
  mkdirSync(join(cur, '.jefe'));
  mkdirSync(join(cur, 'sub'));
  let r = inFolder(join(cur, 'sub'), ['here'], env);
  assert.equal(r.code, 0);
  const real = realpathSync(cur);
  assert.deepEqual(JSON.parse(r.out), { path: real, name: null, handoff: join(real, '.jefe', 'handoff.md') });
  pp(['register', 'mine', cur], env);
  r = inFolder(cur, ['here'], env);
  assert.equal(JSON.parse(r.out).name, 'mine');
  r = inFolder(tmp(), ['here'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { path: null, name: null, handoff: null });
});
