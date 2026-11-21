import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const key = (cwd) => createHash('sha256').update(cwd).digest('hex').slice(0, 16);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

// A folder and its own JEFE_HOME. `g(args, env)` runs jefe-gate there.
function setup({ git = false, run } = {}) {
  const cwd = git ? repo() : tmp();
  const home = tmp();
  if (run) {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', `${key(cwd)}.json`), JSON.stringify({ updatedAt: new Date().toISOString(), ...run }));
  }
  const g = (args, env = {}) => gate(args, cwd, { JEFE_HOME: home, JEFE_HOST: 'testhost', JEFE_MODE: 'headless', ...env });
  return { cwd, home, g, levelFile: join(home, 'run', `${key(cwd)}.level.json`), config: join(home, 'config.json') };
}

const out = (r) => r.out.trim().split('\n');

test('level: default, then user, env and run override in precedence order', () => {
  const s = setup();
  assert.equal(s.g(['level']).out.trim(), 'level: normal (source: default)');
  assert.equal(s.g(['level', 'set', 'thorough']).out.trim(), 'level: thorough (source: user) saved');
  assert.equal(s.g(['level']).out.trim(), 'level: thorough (source: user)');
  assert.equal(s.g(['level'], { JEFE_LEVEL: 'normal' }).out.trim(), 'level: normal (source: env)');
  assert.equal(s.g(['level'], { JEFE_LEVEL: 'garbage' }).out.trim(), 'level: thorough (source: user)');
  assert.deepEqual(readJson(s.config), { level: 'thorough' });
});

test('level set: synonyms, bad value exits 2 listing the valid ones, nothing written', () => {
  const s = setup();
  assert.equal(s.g(['level', 'set', 'eco']).out.trim(), 'level: normal (source: user) saved');
  assert.equal(s.g(['level', 'set', 'all', 'out']).out.trim(), 'level: thorough (source: user) saved');
  assert.equal(s.g(['level', 'set', 'normal']).out.trim(), 'level: normal (source: user) saved'); // old words still work
  assert.equal(s.g(['level', 'set', 'thorough']).out.trim(), 'level: thorough (source: user) saved');
  assert.equal(s.g(['level', 'set', 'normal']).out.trim(), 'level: normal (source: user) saved');
  s.g(['level', 'set', 'thorough']);
  const bad = s.g(['level', 'set', 'ultra']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown value "ultra".*normal.*thorough/);
  assert.equal(s.g(['level', 'set']).code, 2);
  assert.equal(readJson(s.config).level, 'thorough');
});

test('level set merges with existing keys and unset removes only the level', () => {
  const s = setup();
  writeFileSync(s.config, JSON.stringify({ hinted: true, keep: { a: 1 } }));
  assert.equal(s.g(['level', 'set', 'normal']).code, 0);
  assert.deepEqual(readJson(s.config), { hinted: true, keep: { a: 1 }, level: 'normal' });
  const u = s.g(['level', 'unset']);
  assert.equal(u.code, 0);
  assert.match(u.out, /^level: unset \(user\); now normal \(source: default\)/);
  assert.deepEqual(readJson(s.config), { hinted: true, keep: { a: 1 } });
  assert.match(s.g(['level', 'unset']).out, /unset/); // unsetting again is harmless
  const empty = setup();
  assert.match(empty.g(['level', 'unset']).out, /nothing was saved/);
  assert.ok(!existsSync(empty.config));
});

test('level set --project writes <project>/.jefe/config.json and outranks user; unset --project', () => {
  const s = setup();
  mkdirSync(join(s.cwd, '.jefe'));
  assert.equal(s.g(['level', 'set', 'thorough']).code, 0);
  const r = s.g(['level', 'set', 'normal', '--project']);
  assert.equal(r.out.trim(), 'level: normal (source: project) saved');
  assert.deepEqual(readJson(join(s.cwd, '.jefe', 'config.json')), { level: 'normal' });
  assert.equal(s.g(['level']).out.trim(), 'level: normal (source: project)');
  assert.equal(readJson(s.config).level, 'thorough'); // user config untouched
  assert.equal(s.g(['level'], { JEFE_LEVEL: 'thorough' }).out.trim(), 'level: thorough (source: env)');
  const note = s.g(['level', 'set', 'normal', '--project'], { JEFE_LEVEL: 'thorough' });
  assert.match(note.out, /note: thorough is in effect \(source: env\)/);
  assert.match(s.g(['level', 'unset', '--project']).out, /^level: unset \(project\); now thorough \(source: user\)/);
  assert.deepEqual(readJson(join(s.cwd, '.jefe', 'config.json')), {});
});

test('level set --project in a subfolder finds the parent project; outside a project exits 3', () => {
  const s = setup();
  mkdirSync(join(s.cwd, '.jefe'));
  mkdirSync(join(s.cwd, 'sub'));
  const inSub = gate(['level', 'set', 'normal', '--project'], join(s.cwd, 'sub'), { JEFE_HOME: s.home });
  assert.equal(inSub.code, 0, inSub.out);
  assert.ok(existsSync(join(s.cwd, '.jefe', 'config.json')));
  const plain = setup();
  const r = plain.g(['level', 'set', 'normal', '--project']);
  assert.equal(r.code, 3);
  assert.match(r.out.trim(), /^level: this folder is not a Jefe project/);
  assert.equal(r.out.trim().split('\n').length, 1);
  assert.ok(!existsSync(plain.config));
  assert.equal(plain.g(['level', 'unset', '--project']).code, 3);
});

test('a corrupt config is copied aside and never overwritten, with a clear error', () => {
  const s = setup();
  writeFileSync(s.config, '{not json');
  const r = s.g(['level', 'set', 'thorough']);
  assert.equal(r.code, 1);
  assert.match(r.out, /is not valid JSON/);
  assert.match(r.out, /A copy was saved to .*config\.json\.corrupt-/);
  assert.match(r.out, /Nothing was overwritten/);
  assert.equal(readFileSync(s.config, 'utf8'), '{not json');
  assert.ok(readdirSync(s.home).some((n) => n.startsWith('config.json.corrupt-')));
  assert.ok(!/\n\s+at /.test(r.out + r.err));
  // reading a corrupt config never fails a command: the level is just the default
  assert.equal(s.g(['level']).out.trim(), 'level: normal (source: default)');
  assert.equal(s.g(['level', 'unset']).code, 1);
});

test('knobs: level in effect, --level, bad value', () => {
  const s = setup();
  assert.equal(s.g(['knobs']).out.trim(), 'knobs: builder=sonnet reviewers=1 retries=1 parallel=3\nmodels: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)');
  const high = s.g(['knobs', '--level', 'thorough']);
  assert.equal(high.code, 0);
  assert.equal(high.out.trim().split('\n')[0], 'knobs: builder=sonnet reviewers=2 retries=3 parallel=3');
  assert.equal(s.g(['knobs', '--level', 'thorough']).out.trim().split('\n')[0], 'knobs: builder=sonnet reviewers=2 retries=3 parallel=3');
  s.g(['level', 'set', 'normal']);
  assert.equal(s.g(['knobs']).out.trim(), 'knobs: builder=sonnet reviewers=1 retries=1 parallel=3\nmodels: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)');
  assert.match(s.g(['knobs', '--level', 'turbo']).out, /reviewers=2/);
  assert.equal(s.g(['knobs', '--level', 'ultra']).code, 2);
  assert.equal(JSON.parse(s.g(['knobs', '--level', 'normal', '--json']).out).knobs.reviewers, 1);
});

test('start: line order, exit 0, hint once, level file', () => {
  const s = setup({ git: true });
  const r = s.g(['start']);
  assert.equal(r.code, 0, r.out);
  const lines = out(r);
  assert.equal(lines[0], 'mode: headless');
  assert.equal(lines[1], 'where: unknown');
  assert.match(lines[2], /^level: normal \(source: default\)$/);
  assert.equal(lines[3], 'knobs: builder=sonnet reviewers=1 retries=1 parallel=3');
  assert.equal(lines[4], 'models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)');
  assert.equal(lines[5], 'gate: .jefe/bin/jefe-gate');
  // lean: no usage, context, size, project or prefs line when there is nothing to say
  assert.equal(lines[6], 'hint: Level normal is the default. Say "set jefe to thorough" for more reviewing and more fix rounds.');
  // headless only: the commit guidance for the skill (start never grants approvals)
  assert.equal(lines[7], 'git: commit per stage; leave a single job uncommitted unless the request asks for a commit');
  // inside git with a commit: the commit the job starts from, for the reviewers' diff (see gate-base.test.mjs)
  assert.match(lines[8], /^base: [0-9a-f]{7,} \[\S+\]$/);
  // then the destination line: this repository has no remote
  assert.equal(lines[9], 'push-to: none (no remote to push to: the repository has none)');
  // the detected test command (none in this repository)
  assert.equal(lines[10], 'test command: none found');
  // last: the file list the helpers read instead of a Bash listing (tests/start-files.test.mjs)
  assert.match(lines[11], /^files: \.jefe\/files\.txt \(\d+ files?\)$/);
  assert.equal(lines.length, 12, lines.join('\n'));
  assert.equal(readJson(s.config).hinted, true);
  const again = out(s.g(['start']));
  assert.ok(!again.some((l) => l.startsWith('hint:')), 'the hint must appear only once');
  assert.ok(!again.some((l) => l.startsWith('allowed:')), 'a start that granted nothing says nothing about approvals');
  assert.equal(again.length, 11, again.join('\n'));
  assert.equal(again[again.length - 3], 'push-to: none (no remote to push to: the repository has none)');
  assert.equal(again[again.length - 2], 'test command: none found');
  assert.match(again[again.length - 1], /^files: /);
  const f = readJson(s.levelFile);
  assert.equal(f.level, 'normal');
  assert.equal(f.source, 'default');
  assert.ok(Number.isFinite(Date.parse(f.at)));
});

test('start: no hint when the level was chosen (user, env, --level)', () => {
  for (const [prep, args, env] of [
    [(s) => s.g(['level', 'set', 'normal']), ['start'], {}],
    [() => {}, ['start'], { JEFE_LEVEL: 'normal' }],
    [() => {}, ['start', '--level', 'normal'], {}],
  ]) {
    const s = setup();
    prep(s);
    const r = s.g(args, env);
    assert.ok(!r.out.includes('hint:'), r.out);
    assert.match(r.out, /^level: normal \(source: (user|env|run)\)/m);
  }
});

test('start: project line for a project folder, handoff only when the file exists', () => {
  const s = setup();
  mkdirSync(join(s.cwd, '.jefe'));
  assert.equal(out(s.g(['start'])).find((l) => l.startsWith('project:')), undefined, 'a bare .jefe/ (task file, goal) is not a project');
  write(s.cwd, '.jefe/handoff.md', '# Goal\n');
  assert.equal(out(s.g(['start'])).find((l) => l.startsWith('project:')), `project: unregistered path=${s.cwd} handoff=${join(s.cwd, '.jefe', 'handoff.md')}`);
  const env = { ...process.env, JEFE_HOME: s.home, JEFE_HOST: 'testhost' };
  spawnSync(process.execPath, [PP, 'register', 'mine', s.cwd], { env });
  assert.equal(out(s.g(['start'])).find((l) => l.startsWith('project:')), `project: mine path=${s.cwd} handoff=${join(s.cwd, '.jefe', 'handoff.md')}`);
});

test('start --words: matches from jefe-project find, best first, or none; never a shell', () => {
  const s = setup();
  const env = { ...process.env, JEFE_HOME: s.home, JEFE_HOST: 'testhost' };
  for (const [name, dir] of [['street-kingpin', tmp()], ['jefe', tmp()], ['garden-app', tmp()], ['garden-api', tmp()]]) spawnSync(process.execPath, [PP, 'register', name, dir], { env });
  // one clear project elsewhere: the three lines instead of a matches: line
  const r = s.g(['start', '--words', 'continue the street kingpin game']);
  const lines = out(r);
  assert.ok(!lines.some((l) => l.startsWith('matches:')), r.out);
  assert.ok(lines.some((l) => /^resume: cd ".*" && claude "\/jefe:jefe continue street-kingpin"$/.test(l)), r.out);
  // no clear winner: the matches: line, best first
  const amb = out(s.g(['start', '--words', 'garden']));
  assert.match(amb.find((l) => l.startsWith('matches:')), /^matches: garden-a(pp|pi)\(0\.8\) garden-a(pp|pi)\(0\.8\)$/);
  assert.equal(out(s.g(['start', '--words', 'zzzqqq'])).find((l) => l.startsWith('matches:')), 'matches: none');
  assert.ok(!s.g(['start']).out.includes('matches:'));
  const evil = s.g(['start', '--words', '$(touch pwned); `touch pwned2` ; echo hi']);
  assert.equal(evil.code, 0);
  assert.ok(!existsSync(join(s.cwd, 'pwned')) && !existsSync(join(s.cwd, 'pwned2')));
});

const usage = (usedPercent, resetsAt = '2026-11-17T20:30:00Z') => ({ usage: { usedPercent, resetsAt } });
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

test('start: plan usage 84% downshifts thorough to normal, shown on the level and usage lines', () => {
  const s = setup({ run: usage(84) });
  const lines = out(s.g(['start'], { JEFE_LEVEL: 'thorough' }));
  assert.equal(lines[2], 'level: normal (source: env, downshifted from thorough: plan usage 84%)');
  assert.equal(lines[3], 'knobs: builder=sonnet reviewers=1 retries=1 parallel=3'); // the knobs of the effective level
  assert.equal(lines[6], `usage: 84% of plan window, resets ${hhmm('2026-11-17T20:30:00Z')} -> downshift`);
  const f = readJson(s.levelFile);
  assert.equal(f.level, 'normal');
  assert.equal(f.base, 'thorough');
  assert.equal(f.source, 'env');
});

test('start: usage 84% at normal stays normal (no downshift text), 96% parks without changing the level', () => {
  const low = setup({ run: usage(84) });
  const a = out(low.g(['start'], { JEFE_LEVEL: 'normal' }));
  assert.equal(a[2], 'level: normal (source: env)');
  assert.match(a[6], /^usage: 84% of plan window, resets \d\d:\d\d -> downshift$/);
  const park = setup({ run: usage(96) });
  const b = out(park.g(['start'], { JEFE_LEVEL: 'thorough' }));
  assert.equal(b[2], 'level: thorough (source: env, plan usage 96%: park)');
  assert.match(b[6], /^usage: 96% of plan window, resets \d\d:\d\d -> park$/);
  assert.equal(park.g(['start'], { JEFE_LEVEL: 'thorough' }).code, 0);
});

test('start: usage below the threshold, unknown reset, null and stale usage', () => {
  const usageLine = (r) => out(r).find((l) => l.startsWith('usage:'));
  const ok = setup({ run: usage(40.4, null) });
  assert.equal(usageLine(ok.g(['start'])), 'usage: 40% of plan window, resets unknown');
  // lean: nothing measured, no usage line
  assert.equal(usageLine(setup({ run: { usage: null } }).g(['start'])), undefined);
  assert.equal(usageLine(setup({ run: { usage: { usedPercent: null, resetsAt: null } } }).g(['start'])), undefined);
  assert.equal(usageLine(setup({ run: { context: null } }).g(['start'])), undefined); // old run files have no usage
  const stale = setup();
  mkdirSync(join(stale.home, 'run'), { recursive: true });
  writeFileSync(join(stale.home, 'run', `${key(stale.cwd)}.json`), JSON.stringify({ updatedAt: new Date(Date.now() - 7 * 3600e3).toISOString(), ...usage(90) }));
  assert.equal(usageLine(stale.g(['start'])), undefined);
  const t = setup({ run: usage(60) }); // thresholds come from the environment
  assert.match(out(t.g(['start'], { JEFE_USAGE_DOWNSHIFT: '50' })).find((l) => l.startsWith('usage:')), /-> downshift$/);
});

test('start --level overrides env and config, as source run, and is remembered for context and knobs', () => {
  const s = setup();
  s.g(['level', 'set', 'normal']);
  const r = out(s.g(['start', '--level', 'thorough'], { JEFE_LEVEL: 'normal' }));
  assert.equal(r[2], 'level: thorough (source: run)');
  assert.match(r[3], /^knobs: builder=sonnet reviewers=2 retries=3 parallel=3$/);
  assert.equal(readJson(s.levelFile).source, 'run');
  // later calls in the same run see the override without repeating --level
  assert.equal(s.g(['level'], { JEFE_LEVEL: 'normal' }).out.trim(), 'level: thorough (source: run)');
  assert.match(s.g(['context'], { JEFE_LEVEL: 'normal' }).out.split('\n')[0], /^level: thorough \(source: run\)$/);
  assert.match(s.g(['knobs']).out, /reviewers=2/);
  // a new start without --level begins from the configured level again
  assert.equal(out(s.g(['start']))[2], 'level: normal (source: user)');
  assert.equal(s.g(['level']).out.trim(), 'level: normal (source: user)');
  // an unknown --level is ignored with a warning, still exit 0
  const bad = s.g(['start', '--level', 'ultra']);
  assert.equal(bad.code, 0);
  assert.match(out(bad)[2], /^warning: ignoring unknown --level "ultra"/);
  assert.match(out(bad)[3], /^level: normal \(source: user\)/);
});

test('a level set mid-run replaces the run override and shows in context at once', () => {
  const s = setup();
  s.g(['start', '--level', 'thorough']);
  assert.match(s.g(['context']).out, /^level: thorough \(source: run\)/);
  assert.equal(s.g(['level', 'set', 'normal']).out.trim(), 'level: normal (source: user) saved');
  assert.match(s.g(['context']).out, /^level: normal \(source: user\)\ncontext: /);
  assert.equal(readJson(s.levelFile).source, 'user');
  assert.equal(readJson(s.levelFile).level, 'normal');
});

test('context prints the level line first; json carries the level too; downshift shows', () => {
  const s = setup({ run: { context: { tokens: 1000, window: 200000, percent: 0.5, over: false }, ...usage(82) } });
  const r = s.g(['context'], { JEFE_LEVEL: 'thorough' });
  assert.deepEqual(out(r), ['level: normal (source: env, downshifted from thorough: plan usage 82%)', 'context: 1k of 200k tokens (ok)']);
  const j = JSON.parse(s.g(['context', '--json'], { JEFE_LEVEL: 'thorough' }).out);
  assert.equal(j.level, 'normal');
  assert.equal(j.status, 'ok');
  assert.equal(j.downshiftedFrom, 'thorough');
});

test('start --json carries every piece; --help documents the new commands', () => {
  const s = setup({ git: true });
  const j = JSON.parse(s.g(['start', '--json']).out);
  assert.equal(j.level, 'normal');
  assert.equal(j.exit, 0);
  assert.equal(j.knobs.parallel, 3);
  assert.equal(j.where, 'unknown');
  assert.equal(j.gate, '.jefe/bin/jefe-gate');
  assert.equal(j.mode, 'headless');
  assert.equal(j.project.path, null);
  assert.equal(j.hinted, true);
  assert.equal(j.matches, null);
  const h = s.g(['--help']).out;
  for (const w of ['level', 'knobs', 'start', 'verify']) assert.match(h, new RegExp(w));
});

test('start never fails: with a corrupt config it still exits 0 and shows no hint it cannot remember', () => {
  const s = setup();
  writeFileSync(s.config, '{nope');
  const r = s.g(['start']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^mode: headless\nwhere: unknown\nlevel: normal \(source: default\)/);
  assert.ok(!r.out.includes('hint:'));
});

test('start: headless wording only when no run file exists; JSON keeps usage null and adds usageReason', () => {
  const none = setup({ git: true });
  const lines = out(none.g(['start']));
  assert.ok(!lines.some((l) => /^(usage|context):/.test(l)), 'start drops the unknown lines');
  assert.match(none.g(['context']).out, /^context: unknown \(no mod: headless run\)$/m); // the subcommands keep them
  const j = JSON.parse(none.g(['start', '--json']).out);
  assert.equal(j.usage, null);
  assert.equal(j.usageReason, 'no mod: headless run');
  assert.equal(j.context.status, 'unknown');
  assert.equal(j.context.reason, 'no mod: headless run');
  const mod = setup({ git: true, run: { usage: null } });
  assert.ok(!out(mod.g(['start'])).some((l) => /^(usage|context):/.test(l)));
  assert.equal(JSON.parse(mod.g(['start', '--json']).out).usageReason, undefined);
});
