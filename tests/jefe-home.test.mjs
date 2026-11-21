// The status-line mod picks its Jefe home by the same rule as the gate (hooks/jefe-home.mjs pickJefeHome): a relative JEFE_HOME or one inside
// the project (a repository's own settings can set it) falls back to ~/.claude/jefe, so the mod never writes inside the repository and the gate
// sees the mod's usage and cost readings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALIAS_PROBLEM, DOTDOT_PROBLEM, pickJefeHome, realishWith } from '../hooks/jefe-home.mjs';
import { registryInfo, sameFolderAsRoot } from '../hooks/approvals-state.mjs';
import { runFilePath, spawnsFilePath } from '../hooks/runfile.mjs';
import { configPath } from '../hooks/levels.mjs';

const io = { realpath: (p) => realpathSync(p), isLink: (p) => lstatSync(p).isSymbolicLink(), exists: (p) => existsSync(p) };
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-home-')));

// What the mod does (hooks/jefe.jsx homeEnv), with Node's file system in place of $.fs.
async function modHome(root, env) {
  const g = env.JEFE_HOME || undefined;
  const fallback = env.HOME.replace(/\/+$/, '') + '/.claude/jefe';
  return pickJefeHome({ given: g, absolute: Boolean(g && g.startsWith('/')), real: g ? await realishWith(g, io) : null, rootReal: root, fallback, fallbackReal: await realishWith(fallback, io), ci: true, fallbackMustBeOutside: true });
}

function setup() {
  const base = tmp();
  const home = join(base, 'acct');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const proj = join(base, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  return { base, home, proj, def: join(home, '.claude', 'jefe') };
}

test('reproductions: a relative JEFE_HOME and one inside the project put the run file, the spawns file and config.json in the default home', async () => {
  const { home, proj, def } = setup();
  for (const h of ['jh', join(proj, '.jefehome')]) {
    const picked = await modHome(proj, { JEFE_HOME: h, HOME: home });
    assert.equal(picked.home, def, h);
    assert.ok(picked.problem, h);
    const env = { JEFE_HOME: picked.home };
    assert.ok(runFilePath(proj, env).startsWith(def + '/run/'), h);
    assert.ok(spawnsFilePath(proj, env).startsWith(def + '/run/'), h);
    assert.equal(configPath(env), def + '/config.json', h);
    assert.ok(!runFilePath(proj, env).startsWith(proj), h);
  }
});

test('a symlink into the project counts as inside; a case-changed spelling too', async () => {
  const { base, home, proj, def } = setup();
  mkdirSync(join(proj, 'state'));
  const link = join(base, 'link-into-proj');
  symlinkSync(join(proj, 'state'), link);
  assert.equal((await modHome(proj, { JEFE_HOME: link, HOME: home })).home, def);
  assert.equal((await modHome(proj, { JEFE_HOME: join(proj.toUpperCase(), 'x'), HOME: home })).home, def);
});

test('pickJefeHome with ci: the NFC and NFD spellings of a folder name are one folder; without ci (Linux) they are two', () => {
  const nfc = '/w/café';
  const nfd = '/w/café';
  const base = { absolute: true, fallback: '/h/.claude/jefe', fallbackReal: '/h/.claude/jefe' };
  for (const [root, given] of [[nfc, nfd + '/.jh'], [nfd, nfc + '/.jh'], [nfc, '/w/CAFÉ/.jh'], [nfc, nfd]]) {
    assert.deepEqual(pickJefeHome({ ...base, given, real: given, rootReal: root, ci: true }), { home: '/h/.claude/jefe', problem: 'JEFE_HOME is inside the project folder' }, given);
    // the mod's own fallback is refused by the same test
    assert.equal(pickJefeHome({ ...base, given: undefined, rootReal: root, fallback: given, fallbackReal: given, ci: true, fallbackMustBeOutside: true }).home, null, given);
  }
  assert.deepEqual(pickJefeHome({ ...base, given: nfd + '/.jh', real: nfd + '/.jh', rootReal: nfc, ci: false }), { home: nfd + '/.jh', problem: null });
  // the folded comparison drops accents, so `cafe` counts as `café` too: two different folders refused, which fails safe to the default home
  assert.deepEqual(pickJefeHome({ ...base, given: '/w/cafe/.jh', real: '/w/cafe/.jh', rootReal: nfc, ci: true }), { home: '/h/.claude/jefe', problem: 'JEFE_HOME is inside the project folder' });
  assert.deepEqual(pickJefeHome({ ...base, given: '/w/cafes/.jh', real: '/w/cafes/.jh', rootReal: nfc, ci: true }), { home: '/w/cafes/.jh', problem: null });
});

test('pickJefeHome with ci: names a case-insensitive volume folds alike are one folder (sharp s, ligatures, final sigma), both ways', () => {
  const c = (...n) => String.fromCodePoint(...n);
  const base = { absolute: true, fallback: '/h/.claude/jefe', fallbackReal: '/h/.claude/jefe' };
  const pairs = [
    ['strasse', 'stra' + c(0xdf) + 'e'], // sharp s
    ['fluff', 'flu' + c(0xfb00)], // ff ligature
    ['office', 'o' + c(0xfb03) + 'ce'], // ffi ligature
    [c(0x3bf, 0x3b4, 0x3bf, 0x3c2), c(0x3bf, 0x3b4, 0x3bf, 0x3c3)], // Greek final sigma and ordinary sigma
  ];
  for (const [a, b] of pairs) {
    for (const [rootName, homeName] of [[a, b], [b, a]]) {
      const root = '/w/' + rootName;
      for (const given of ['/w/' + homeName + '/.jh', '/w/' + homeName]) {
        assert.deepEqual(pickJefeHome({ ...base, given, real: given, rootReal: root, ci: true }), { home: '/h/.claude/jefe', problem: 'JEFE_HOME is inside the project folder' }, given);
        assert.equal(pickJefeHome({ ...base, given: undefined, rootReal: root, fallback: given, fallbackReal: given, ci: true, fallbackMustBeOutside: true }).home, null, given);
        // without ci (Linux) the two spellings are two folders
        assert.deepEqual(pickJefeHome({ ...base, given, real: given, rootReal: root, ci: false }), { home: given, problem: null }, given);
      }
    }
    // a genuinely different folder outside the project, and a parent of the project, are still accepted
    for (const given of ['/w/other/.jh', '/w', '/w/' + a + '-sibling/.jh']) {
      assert.deepEqual(pickJefeHome({ ...base, given, real: given, rootReal: '/w/' + b, ci: true }), { home: given, problem: null }, given);
    }
  }
});

test('a dangling symlink as JEFE_HOME is not resolved (a write through it would create its target)', async () => {
  const { base, home, proj, def } = setup();
  const dangling = join(base, 'dangling');
  symlinkSync(join(proj, 'not-yet'), dangling);
  const picked = await modHome(proj, { JEFE_HOME: dangling, HOME: home });
  assert.equal(picked.home, def);
  assert.equal(picked.problem, 'JEFE_HOME cannot be resolved');
});

test('an absolute JEFE_HOME outside the project still works, even before it exists', async () => {
  const { base, home, proj } = setup();
  const jh = join(base, 'elsewhere', 'jefe');
  const picked = await modHome(proj, { JEFE_HOME: jh, HOME: home });
  assert.deepEqual(picked, { home: jh, problem: null });
  assert.ok(runFilePath(proj, { JEFE_HOME: picked.home }).startsWith(jh + '/run/'));
});

test('the mod and the gate agree (pickJefeHome as the mod calls it, registryInfo as the gate does)', async () => {
  const { base, home, proj } = setup();
  mkdirSync(join(proj, 'sub'));
  const cases = ['', 'jh', join(proj, '.jefehome'), join(proj, 'sub'), proj, join(base, 'out'), join(base, 'out', 'deeper'), join(base, 'proj-sibling')];
  for (const h of cases) {
    const env = { JEFE_HOME: h, HOME: home };
    const mod = await modHome(proj, env);
    const gate = registryInfo(proj, { env, home, platform: 'darwin' });
    assert.deepEqual(mod, gate, JSON.stringify(h));
  }
  // Where the two sides differ on purpose: HOME pointing inside the project. The mod's fallback is $HOME/.claude/jefe, and a repository's settings
  // can set HOME, so the mod takes no home at all (writes nothing). The gate's fallback is the account database's home folder (here the `home`
  // option), which a repository cannot move, so it keeps its default.
  const fake = join(proj, 'fakehome');
  mkdirSync(join(fake, '.claude'), { recursive: true });
  for (const h of ['', join(proj, '.jefehome')]) {
    const mod = await modHome(proj, { JEFE_HOME: h, HOME: fake });
    assert.equal(mod.home, null, JSON.stringify(h));
    assert.match(mod.problem, /default registry location is inside the project folder/);
    const gate = registryInfo(proj, { env: { JEFE_HOME: h, HOME: fake }, home, platform: 'darwin' });
    assert.equal(gate.home, join(home, '.claude', 'jefe'));
  }
  // an absolute JEFE_HOME outside the project still wins over a HOME inside it
  assert.equal((await modHome(proj, { JEFE_HOME: join(base, 'out'), HOME: fake })).home, join(base, 'out'));
});

test('pickJefeHome: fallbackMustBeOutside only refuses a fallback inside the project; the default (gate side) never does', () => {
  const args = { given: undefined, absolute: false, real: null, rootReal: '/p', fallback: '/p/h/.claude/jefe', fallbackReal: '/p/h/.claude/jefe' };
  assert.equal(pickJefeHome(args).home, '/p/h/.claude/jefe');
  assert.equal(pickJefeHome({ ...args, fallbackMustBeOutside: true }).home, null);
  assert.equal(pickJefeHome({ ...args, fallbackMustBeOutside: true, fallback: '/q/.claude/jefe', fallbackReal: '/q/.claude/jefe' }).home, '/q/.claude/jefe');
});

test('realishWith: the nearest existing folder is resolved and the rest appended; relative paths are refused', async () => {
  const { base } = setup();
  assert.equal(await realishWith(join(base, 'a', 'b'), io), join(base, 'a', 'b'));
  assert.equal(await realishWith(base, io), base);
  assert.equal(await realishWith('rel/path', io), null);
  assert.equal(await realishWith('/', io), '/');
});

// A realpath that does not normalise (returns an existing path as given): the mod's $.fs.realpath is not promised to clean `..` up.
const literalIo = (existing) => ({
  realpath: (p) => {
    if (existing.has(p)) return p;
    throw new Error('ENOENT');
  },
  isLink: () => false,
});

test('realishWith refuses any `..` segment, even when the realpath does not normalise', async () => {
  const io2 = literalIo(new Set(['/', '/d', '/d/p2', '/d/p2/proj']));
  for (const p of ['/d/p2/missing/../proj/.jh', '/d/p2/other/missing/../../proj/.jh', '/d/..', '/..']) assert.equal(await realishWith(p, io2), null, p);
  const picked = pickJefeHome({ given: '/d/p2/missing/../proj/.jh', absolute: true, real: await realishWith('/d/p2/missing/../proj/.jh', io2), rootReal: '/d/p2/proj', fallback: '/h/.claude/jefe', fallbackReal: '/h/.claude/jefe', ci: true });
  assert.deepEqual(picked, { home: '/h/.claude/jefe', problem: DOTDOT_PROBLEM });
});

test('a `..` segment in JEFE_HOME: the gate and the mod both refuse it with the same problem and the same fallback; `b..c` is a plain name', async () => {
  const { base, home, proj, def } = setup();
  mkdirSync(join(base, 'shared'));
  for (const h of [`${home}/../shared/jefe`, '/a/b/../c', '/a/..', `${base}/x/../out`]) {
    const env = { JEFE_HOME: h, HOME: home };
    const mod = await modHome(proj, env);
    const gate = registryInfo(proj, { env, home, platform: 'darwin' });
    assert.deepEqual(mod, { home: def, problem: DOTDOT_PROBLEM }, h);
    assert.deepEqual(gate, mod, h);
    assert.deepEqual(registryInfo(proj, { env, home, platform: 'linux' }), mod, h);
  }
  for (const h of [`${base}/b..c/d`, `${base}/..x/jefe`, `${base}/x../jefe`, `${base}/./out//jefe`]) {
    const env = { JEFE_HOME: h, HOME: home };
    const mod = await modHome(proj, env);
    assert.deepEqual(mod, { home: h, problem: null }, h);
    assert.deepEqual(registryInfo(proj, { env, home, platform: 'darwin' }), mod, h);
  }
});

test('realishWith drops `.` segments and doubled slashes before the walk', async () => {
  const io2 = literalIo(new Set(['/', '/d', '/d/p2', '/d/p2/proj']));
  assert.equal(await realishWith('/d//p2/./proj/.jh', io2), '/d/p2/proj/.jh');
  assert.equal(await realishWith('/d/p2/proj/./', io2), '/d/p2/proj');
  assert.equal(await realishWith('//d/./out/x', io2), '/d/out/x');
  // so the inside test sees the project
  const real = await realishWith('/d//p2/./proj/.jh', io2);
  assert.equal(pickJefeHome({ given: '/d//p2/./proj/.jh', absolute: true, real, rootReal: '/d/p2/proj', fallback: '/h/.claude/jefe', fallbackReal: '/h/.claude/jefe' }).home, '/h/.claude/jefe');
});

test('the mod reads JEFE_HOME in one place only and passes the checked home to every path helper', () => {
  const src = readFileSync(new URL('../hooks/jefe.jsx', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((src.match(/\$\.env\.get\('JEFE_HOME'\)/g) || []).length, 1);
  assert.match(src, /async function homeEnv\(\$, root\)[\s\S]*?\$\.env\.get\('JEFE_HOME'\)[\s\S]*?pickJefeHome\(/);
  for (const fn of ['runFilePath', 'gateFilePath', 'levelFilePath', 'spawnsFilePath', 'reportFilePath', 'allowFilePath', 'configPath']) {
    for (const l of src.split('\n').filter((x) => x.includes(`${fn}(`))) assert.ok(/\benv\)/.test(l), l.trim());
  }
});

// macOS reaches one folder by other paths that realpath keeps as they are (/System/Volumes/Data<p>, /.nofollow<p>) or cannot resolve
// (/.resolve/<n><p>, /.vol/<dev>/<ino>). A JEFE_HOME through any of them must be refused like the plain path, by the gate and the mod alike.
const INSIDE = 'JEFE_HOME is inside the project folder';
const FB = { fallback: '/h/.claude/jefe', fallbackReal: '/h/.claude/jefe' };
const R = '/Users/user/proj';
// a model of what realpath does with each alias on macOS: the first two are kept as given, the other two throw although the path exists
const aliasIo = (existing) => ({
  realpath: (p) => {
    if (/^\/\.(resolve|vol)(\/|$)/.test(p)) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    if (existing.has(p)) return p;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  isLink: () => false,
  exists: (p) => existing.has(p),
});

test('pickJefeHome and realishWith: every macOS alias of the project (the folder itself, a folder in it that exists or not) is refused', async () => {
  const aliases = ['/System/Volumes/Data' + R, '/.nofollow' + R, '/.resolve/1' + R, '/.vol/16777231/4242'];
  const existing = new Set(['/', '/Users', '/Users/user', R, R + '/.jh', '/h', '/h/.claude', '/h/.claude/jefe']);
  for (const a of aliases) for (const p of [a, a + '/.jh']) existing.add(p);
  for (const s of ['/System', '/System/Volumes', '/System/Volumes/Data', '/System/Volumes/Data/Users', '/System/Volumes/Data/Users/user', '/.nofollow', '/.nofollow/Users', '/.nofollow/Users/user', '/.resolve', '/.resolve/1', '/.vol', '/.vol/16777231']) existing.add(s);
  const io2 = aliasIo(existing);
  for (const a of aliases) {
    for (const given of [a, a + '/.jh', a + '/not-yet']) {
      const real = await realishWith(given, io2);
      if (a.startsWith('/.resolve') || a.startsWith('/.vol')) assert.equal(real, null, given); // there, but it does not resolve: no walking up to /.vol
      for (const ci of [true, false]) {
        const picked = pickJefeHome({ ...FB, given, absolute: true, real, rootReal: R, ci });
        assert.equal(picked.home, '/h/.claude/jefe', given);
        assert.equal(picked.problem, a.startsWith('/System') ? INSIDE : ALIAS_PROBLEM, given);
      }
    }
  }
  // folded where volumes are case-insensitive
  assert.equal(pickJefeHome({ ...FB, given: '/system/VOLUMES/data' + R + '/.jh', absolute: true, real: '/system/VOLUMES/data' + R + '/.jh', rootReal: R, ci: true }).problem, INSIDE);
  assert.equal(pickJefeHome({ ...FB, given: '/.NoFollow' + R, absolute: true, real: '/.NoFollow' + R, rootReal: R, ci: true }).problem, ALIAS_PROBLEM);
  // the mod's own fallback ($HOME) through an alias that does not resolve gives no real path, so no home at all
  assert.equal(pickJefeHome({ given: undefined, rootReal: R, fallback: '/.vol/16777231/4242/.claude/jefe', fallbackReal: await realishWith('/.vol/16777231/4242/.claude/jefe', io2), ci: true, fallbackMustBeOutside: true }).home, null);
});

test('pickJefeHome: an alias on the project side is seen through too; /System/Volumes/Data/<elsewhere> is still outside', () => {
  for (const root of ['/System/Volumes/Data' + R, '/.nofollow' + R, '/.resolve/1' + R, '/.nofollow/System/Volumes/Data' + R]) {
    for (const given of [R, R + '/.jh', '/System/Volumes/Data' + R + '/.jh']) {
      assert.deepEqual(pickJefeHome({ ...FB, given, absolute: true, real: given, rootReal: root, ci: true }), { home: '/h/.claude/jefe', problem: INSIDE }, root + ' ' + given);
    }
    for (const given of ['/Users/user/other/.jh', '/Users/user/proj-sibling', '/Users/user', '/System/Volumes/Data/Users/user/other']) {
      assert.deepEqual(pickJefeHome({ ...FB, given, absolute: true, real: given, rootReal: root, ci: true }), { home: given, problem: null }, root + ' ' + given);
    }
    // the mod's fallback through the same alias as the project is refused
    assert.equal(pickJefeHome({ given: undefined, rootReal: root, fallback: R + '/h/.claude/jefe', fallbackReal: R + '/h/.claude/jefe', ci: true, fallbackMustBeOutside: true }).home, null);
  }
  for (const given of ['/System/Volumes/Data/Users/user/other/.jh', '/System/Volumes/Data/Users/user/proj-sibling', '/System/Volumes/Data', '/System/Volumes/Data/Users']) {
    assert.deepEqual(pickJefeHome({ ...FB, given, absolute: true, real: given, rootReal: R, ci: true }), { home: given, problem: null }, given);
  }
  // a folder merely named like the prefix, deeper down, is a plain name
  const deep = '/x/System/Volumes/Data' + R;
  assert.deepEqual(pickJefeHome({ ...FB, given: deep, absolute: true, real: deep, rootReal: R, ci: true }), { home: deep, problem: null });
  // a JEFE_HOME whose text is inside the project is refused even when its real path leads out (a link the repository controls)
  assert.equal(pickJefeHome({ ...FB, given: R + '/link-out', absolute: true, real: '/elsewhere', rootReal: R }).problem, INSIDE);
});

test('pickJefeHome: sameFolder (the gate found the project folder itself on the way up) counts as inside; the order of the checks is kept', () => {
  assert.deepEqual(pickJefeHome({ ...FB, given: '/a/b', absolute: true, real: '/a/b', rootReal: R, sameFolder: true }), { home: '/h/.claude/jefe', problem: INSIDE });
  assert.equal(pickJefeHome({ ...FB, given: 'rel', absolute: false, real: null, rootReal: R, sameFolder: true }).problem, 'JEFE_HOME is not an absolute path');
  assert.equal(pickJefeHome({ ...FB, given: '/a/../b', absolute: true, real: '/b', rootReal: R, sameFolder: true }).problem, DOTDOT_PROBLEM);
  assert.equal(pickJefeHome({ ...FB, given: '/a/b', absolute: true, real: null, rootReal: R, sameFolder: true }).problem, 'JEFE_HOME cannot be resolved');
});

test('the gate compares the folders themselves: the project reached through a link or another spelling is the project (every platform)', () => {
  const { base, home, proj } = setup();
  mkdirSync(join(proj, '.jh'));
  const link = join(base, 'link-to-proj');
  symlinkSync(proj, link);
  assert.equal(sameFolderAsRoot([join(link, '.jh')], proj), true);
  assert.equal(sameFolderAsRoot([join(link, 'not-yet', 'deeper')], proj), true);
  assert.equal(sameFolderAsRoot([join(base, 'out', 'x'), base, join(base, 'proj-sibling')], proj), false);
  assert.equal(sameFolderAsRoot([join(link, '.jh')], join(base, 'gone')), false); // a root that cannot be read: no identity test
  // letter case: on a case-insensitive volume (the macOS default) the other spelling is the project even with the text rules off (ci false)
  const upper = join(base, 'PROJ', '.jh');
  const env = { JEFE_HOME: upper };
  const gate = registryInfo(proj, { env, home, platform: 'linux' });
  if (existsSync(join(base, 'PROJ'))) assert.deepEqual(gate, { home: join(home, '.claude', 'jefe'), problem: INSIDE });
  else assert.deepEqual(gate, { home: upper, problem: null });
});

test('darwin: JEFE_HOME through each real macOS alias of a project folder is refused by the gate and the mod alike', { skip: process.platform !== 'darwin' }, async () => {
  const { base, home, proj } = setup();
  mkdirSync(join(proj, '.jh'));
  const st = statSync(proj);
  const aliases = ['/System/Volumes/Data' + proj, '/.nofollow' + proj, '/.resolve/1' + proj, '/.vol/' + st.dev + '/' + st.ino];
  let seen = 0;
  for (const a of aliases) {
    let same = false;
    try {
      const s = statSync(a);
      same = s.dev === st.dev && s.ino === st.ino;
    } catch {
      // this alias is not offered here
    }
    if (!same) continue;
    seen++;
    assert.equal(sameFolderAsRoot([a + '/.jh'], proj), true, a);
    for (const h of [a, a + '/.jh', a + '/not-yet']) {
      const env = { JEFE_HOME: h, HOME: home };
      const gate = registryInfo(proj, { env, home, platform: 'darwin' });
      assert.equal(gate.home, join(home, '.claude', 'jefe'), h);
      assert.ok(gate.problem === INSIDE || gate.problem === ALIAS_PROBLEM, h + ': ' + gate.problem);
      assert.deepEqual(await modHome(proj, env), gate, h);
    }
  }
  assert.ok(seen >= 2, 'at least /System/Volumes/Data and /.vol reach the folder on macOS');
  // a sibling outside the project through /System/Volumes/Data is an honest outside path on both sides
  const out = '/System/Volumes/Data' + join(base, 'out');
  if (existsSync('/System/Volumes/Data' + base)) {
    const env = { JEFE_HOME: out, HOME: home };
    assert.deepEqual(registryInfo(proj, { env, home, platform: 'darwin' }), { home: out, problem: null });
    assert.deepEqual(await modHome(proj, env), { home: out, problem: null });
  }
});
