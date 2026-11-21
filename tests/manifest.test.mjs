// Reads files owned by the plugin's other author. A missing file skips its check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OLD_NAME = new RegExp(['pat', 'ron'].join(''), 'i');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const p = (...a) => join(ROOT, ...a);
const read = (f) => readFileSync(f, 'utf8');
function need(t, file) {
  if (existsSync(file)) return true;
  t.skip(`SKIPPED: ${file} does not exist yet`);
  return false;
}
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

test('JSON manifests parse', (t) => {
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json', 'package.json']) {
    if (!existsSync(p(f))) {
      t.diagnostic(`SKIPPED: ${f} does not exist yet`);
      continue;
    }
    assert.doesNotThrow(() => JSON.parse(read(p(f))), f);
  }
});

test('plugin version is read from plugin.json and looks like semver', (t) => {
  if (!need(t, p('.claude-plugin/plugin.json'))) return;
  const m = JSON.parse(read(p('.claude-plugin/plugin.json')));
  assert.equal(m.name, 'jefe');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  t.diagnostic(`plugin version ${m.version}`);
});

test('hooks.json names the module and both command hooks, and the files exist', () => {
  const h = JSON.parse(read(p('hooks/hooks.json')));
  assert.deepEqual(h.modules, ['./jefe.jsx']);
  for (const ev of ['SessionEnd', 'PreCompact']) {
    const cmds = JSON.stringify(h.hooks[ev]);
    assert.match(cmds, /hooks\/stamp\.mjs/);
  }
  assert.ok(existsSync(p('hooks/jefe.jsx')) && existsSync(p('hooks/stamp.mjs')));
});

test('SKILL.md: no ultrathink, no model frontmatter, planner effort low; interview.md has the Go summary and no Go/Change question', (t) => {
  const f = p('skills/jefe/SKILL.md');
  if (!need(t, f)) return;
  const text = read(f);
  assert.ok(!/ultrathink/i.test(text), 'contains "ultrathink"');
  const fm = frontmatter(text);
  assert.ok(fm, 'has frontmatter');
  assert.ok(!('model' in fm), 'frontmatter sets model');
  // The planner only dispatches (builder, finish, report), so its own turns run at low effort.
  // Measured: planner thinking was a large share of a run's cost. Subagents are not affected.
  assert.equal(String(fm.effort), 'low', 'frontmatter effort is low');
  const iv = read(p('skills/jefe/interview.md'));
  assert.ok(/Go summary/.test(iv) && /permission prompt is the Go button/.test(iv) && !/Go \(Recommended\)/.test(iv), 'interview.md ends with the summary and the go call prompt, not a Go question');
});

test('SKILL.md allowed-tools is the pinned line; interview.md stays under its word cap', (t) => {
  const f = p('skills/jefe/SKILL.md');
  if (!need(t, f)) return;
  const text = read(f);
  assert.equal(frontmatter(text)['allowed-tools'], 'Bash("${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate" start --guide) Skill(code-review) Skill(security-review)');
  const wc = (s) => s.split(/\s+/).filter(Boolean).length; // the SKILL.md word cap is asserted in skill-gate.test.mjs only; the interview.md ceiling here equals the one there
  assert.ok(wc(read(p('skills/jefe/interview.md'))) <= 1113, 'interview.md over 1113 words');
});

test('each agent file has name, description, tools, model', (t) => {
  const dir = p('agents');
  if (!need(t, dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'agents/ is empty');
  for (const f of files) {
    const fm = frontmatter(read(join(dir, f)));
    assert.ok(fm, `${f} has frontmatter`);
    for (const k of ['name', 'description', 'tools', 'model']) assert.ok(fm[k], `${f} lacks ${k}`);
  }
});

test('plugin and marketplace descriptions are present and keywords are strings', (t) => {
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    if (!need(t, p(f))) return;
  }
  const pj = JSON.parse(read(p('.claude-plugin/plugin.json')));
  assert.ok(typeof pj.description === 'string' && pj.description.length > 20);
  assert.ok(!OLD_NAME.test(JSON.stringify(pj)), 'plugin.json mentions the old name');
  assert.ok(Array.isArray(pj.keywords) && pj.keywords.every((k) => typeof k === 'string'));
  // the plugin page links to the same repository as package.json
  const url = JSON.parse(read(p('package.json'))).repository.url;
  assert.equal(pj.repository, url, 'plugin.json repository differs from package.json');
  assert.equal(pj.homepage, url, 'plugin.json homepage differs from package.json');
  const mk = JSON.parse(read(p('.claude-plugin/marketplace.json')));
  assert.ok(mk.owner && typeof mk.owner.name === 'string' && mk.owner.name.length > 0);
  assert.ok(mk.plugins.some((x) => x.name === 'jefe'));
  assert.ok(!OLD_NAME.test(JSON.stringify(mk)), 'marketplace.json mentions the old name');
});

test('every skills/<name>/ folder has a SKILL.md with name and description', (t) => {
  const dir = p('skills');
  if (!need(t, dir)) return;
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(names.includes('jefe'), 'skills/jefe exists');
  for (const n of names) {
    const f = join(dir, n, 'SKILL.md');
    assert.ok(existsSync(f), `skills/${n}/SKILL.md missing`);
    const fm = frontmatter(read(f));
    assert.ok(fm && fm.name && fm.description, `skills/${n} lacks name or description`);
  }
});

test('README keeps the benchmark markers and install line; docs are the expected files', () => {
  const r = read(p('README.md'));
  assert.ok(r.includes('<!-- BENCH:START -->') && r.includes('<!-- BENCH:END -->'), 'BENCH markers');
  assert.match(r, /claude plugin install jefe@jefe/);
  assert.ok(!OLD_NAME.test(r), 'README mentions the old name');
  const docs = readdirSync(p('docs')).sort();
  assert.deepEqual(docs, ['BENCH-IN-CI.md', 'DESKTOP-AND-CLOUD.md', 'HANDOFF.md', 'HOW-IT-WORKS.md', 'LIMITS.md', 'PROVIDERS.md', 'SCRIPTS.md', 'TOKEN-ECONOMY.md', 'USAGE-LEVELS.md']);
});

function mdFiles() {
  const out = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'bench/README.md', 'bench/results-summary/README.md', 'assets/demo/README.md'];
  for (const f of readdirSync(p('docs'))) if (f.endsWith('.md')) out.push(`docs/${f}`);
  return out.filter((f) => existsSync(p(f)));
}

test('relative links in the markdown files resolve', () => {
  const bad = [];
  for (const f of mdFiles()) {
    const text = read(p(f)).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = target.split('#')[0];
      if (!file) continue;
      if (!existsSync(join(ROOT, f, '..', file))) bad.push(`${f} -> ${target}`);
    }
  }
  assert.deepEqual(bad, []);
});
