// The raw streams kept in bench/results are uploaded as workflow artifacts, public once the repository is: no rate-limit
// event and no account or machine field of the init line may be in them; the transcript itself stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicStream } from '../bench/public-stream.mjs';

const init = {
  type: 'system', subtype: 'init', cwd: '/tmp/jefe-bench-x', session_id: 's1', model: 'claude-x', tools: ['Bash'], plugins: [{ name: 'jefe', path: '/tmp/p' }],
  apiKeySource: 'none', memory_paths: { auto: '/home/someone/.claude/projects/x/memory/' }, messaging_socket_path: '/tmp/cc-socks/1.sock',
  account_uuid: 'acct-1', organization_id: 'org-1', email: 'someone@example.invalid', user_id: 'u-1',
};
const rate = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.42, isUsingOverage: false, overageStatus: 'rejected', resetsAt: 1794934800 }, uuid: 'r', session_id: 's1' };
const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'see /home/someone/project' }] }, session_id: 's1' };
const result = { type: 'result', subtype: 'success', total_cost_usd: 0.5, result: 'done', session_id: 's1' };

test('rate-limit events are dropped; the init line loses account and machine fields; the transcript and result stay', () => {
  const text = [init, rate, assistant, 'not json at all', result].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
  const out = publicStream(text);
  assert.ok(!/rate_limit|utilization|overage/i.test(out), out);
  assert.ok(!/apiKeySource|memory_paths|messaging_socket_path|acct-1|org-1|someone@|u-1/.test(out), out);
  const lines = out.split('\n');
  const first = JSON.parse(lines[0]);
  assert.equal(first.subtype, 'init');
  assert.equal(first.model, 'claude-x');
  assert.deepEqual(first.tools, ['Bash']);
  assert.equal(first.cwd, '/tmp/jefe-bench-x');
  assert.equal(lines[1], JSON.stringify(assistant)); // the transcript line is kept byte for byte
  assert.equal(lines[2], 'not json at all');
  assert.equal(lines[3], JSON.stringify(result));
  assert.equal(lines[4], ''); // the trailing newline is kept
});

test('empty or missing input gives empty text', () => {
  assert.equal(publicStream(''), '');
  assert.equal(publicStream(undefined), '');
});
