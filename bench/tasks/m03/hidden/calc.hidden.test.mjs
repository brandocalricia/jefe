import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calc } from '../src/calc.mjs';
import { CalcError } from '../src/errors.mjs';
import { main } from '../src/cli.mjs';

const bad = (text, position, vars) => {
  assert.throws(
    () => calc(text, vars),
    (e) => {
      assert.ok(e instanceof CalcError, `${JSON.stringify(text)} should throw CalcError, got ${e}`);
      assert.equal(e.position, position, `position for ${JSON.stringify(text)}: ${e.message}`);
      return true;
    },
  );
};

test('numbers and whitespace', () => {
  assert.equal(calc('42'), 42);
  assert.equal(calc('3.14'), 3.14);
  assert.equal(calc('  1\t+\n2  '), 3);
  assert.equal(calc('0.1 + 0.2'), 0.1 + 0.2);
  assert.equal(calc('007'), 7);
});

test('precedence and associativity', () => {
  assert.equal(calc('1 + 2 * 3'), 7);
  assert.equal(calc('2 * 3 + 1'), 7);
  assert.equal(calc('10 - 4 - 3'), 3);
  assert.equal(calc('100 / 10 / 5'), 2);
  assert.equal(calc('2 * 3 % 4'), 2);
  assert.equal(calc('7 % 4 * 2'), 6);
  assert.equal(calc('(1 + 2) * (3 + 4)'), 21);
  assert.equal(calc('((((5))))'), 5);
});

test('modulo follows JavaScript', () => {
  assert.equal(calc('7 % 3'), 1);
  assert.equal(calc('-7 % 3'), -1);
  assert.equal(calc('7 % -3'), 1);
  assert.equal(calc('5.5 % 2'), 1.5);
});

test('unary operators', () => {
  assert.equal(calc('-3'), -3);
  assert.equal(calc('--3'), 3);
  assert.equal(calc('+-+3'), -3);
  assert.equal(calc('2 * -3'), -6);
  assert.equal(calc('-(1 + 2)'), -3);
  assert.equal(calc('4 - -2'), 6);
});

test('power', () => {
  assert.equal(calc('2^10'), 1024);
  assert.equal(calc('2^3^2'), 512);
  assert.equal(calc('(2^3)^2'), 64);
  assert.equal(calc('-2^2'), -4);
  assert.equal(calc('(-2)^2'), 4);
  assert.equal(calc('2^-1'), 0.5);
  assert.equal(calc('2 * 3^2'), 18);
  assert.equal(calc('2^2 * 3'), 12);
  assert.equal(calc('-2^-2'), -0.25);
});

test('variables', () => {
  assert.equal(calc('x * 2', { x: 21 }), 42);
  assert.equal(calc('a_1 + _b', { a_1: 1, _b: 2 }), 3);
  assert.equal(calc('X + x', { X: 1, x: 10 }), 11);
  assert.equal(calc('-x^2', { x: 3 }), -9);
  assert.equal(calc('x', { x: 0 }), 0);
});

test('functions', () => {
  assert.equal(calc('min(3, 1, 2)'), 1);
  assert.equal(calc('max(3, 1, 2)'), 3);
  assert.equal(calc('max(5)'), 5);
  assert.equal(calc('sqrt(16)'), 4);
  assert.equal(calc('abs(-2.5)'), 2.5);
  assert.equal(calc('max(1, 2) + min(5, 4) * 2'), 10);
  assert.equal(calc('sqrt(max(x, 4))', { x: 9 }), 3);
  assert.equal(calc('max( 1 , min( 2 , 3 ) )'), 2);
  assert.equal(calc('abs(-3)^2'), 9);
});

test('syntax errors carry the position of the first thing that cannot be accepted', () => {
  bad('', 0);
  bad('   ', 3);
  bad('1 +', 3);
  bad('* 3', 0);
  bad('1 + $', 4);
  bad('1 2', 2);
  bad('(1 + 2', 6);
  bad('1 + 2)', 5);
  bad('()', 1);
  bad('max(1,)', 6);
  bad('max(1 2)', 6);
  bad('max(1, 2', 8);
  bad('3.', 1);
  bad('.5', 0);
  bad('1.5.2', 3);
  bad('1e3', 1);
  bad('2 3 4', 2);
  bad('1 + * 2', 4);
});

test('name errors carry the start of the name', () => {
  bad('1 + y', 4, { x: 1 });
  bad('  foo', 2);
  bad('2 * foo(1)', 4);
  bad('x + yy', 4, { x: 1 });
  bad('min()', 0);
  bad('sqrt(1, 2)', 0);
  bad('abs()', 0);
  bad('1 + max()', 4);
});

test('variables are own properties only', () => {
  bad('constructor', 0);
  bad('toString', 0);
  bad('hasOwnProperty + 1', 0, {});
  assert.equal(calc('x', Object.assign(Object.create({ x: 1 }), { x: 2 })), 2);
  bad('x', 0, Object.create({ x: 1 }));
});

test('results that are not finite numbers are errors', () => {
  for (const text of ['1 / 0', '0 / 0', '5 % 0', 'sqrt(-1)', '10^400', '0^-1', '1 / (2 - 2)', 'x / 0']) {
    assert.throws(() => calc(text, { x: 1 }), CalcError, text);
  }
  assert.equal(calc('0 / 5'), 0);
});

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(''), err: err.join('') };
}

const USAGE = 'usage: calc <expression> [--var name=value]...\n';

test('cli prints the result', () => {
  assert.deepEqual(run(['1 + 2 * 3']), { code: 0, out: '7\n', err: '' });
  assert.deepEqual(run(['2 / 4']), { code: 0, out: '0.5\n', err: '' });
  assert.deepEqual(run(['x * y', '--var', 'x=6', '--var', 'y=7']), { code: 0, out: '42\n', err: '' });
  assert.deepEqual(run(['x + 1', '--var', 'x=1.5']), { code: 0, out: '2.5\n', err: '' });
  assert.deepEqual(run(['-3']), { code: 0, out: '-3\n', err: '' });
  assert.deepEqual(run(['x', '--var', 'x=-2']), { code: 0, out: '-2\n', err: '' });
});

test('cli reports CalcErrors with the position and returns 1', () => {
  const r = run(['1 + $']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^error: .+ \(at 4\)\n$/);
  const u = run(['y + 1']);
  assert.equal(u.code, 1);
  assert.match(u.err, /^error: .*y.* \(at 0\)\n$/);
  const z = run(['1 / 0']);
  assert.equal(z.code, 1);
  assert.match(z.err, /^error: .+ \(at \d+\)\n$/);
  assert.equal(run(['1 +']).err.endsWith('(at 3)\n'), true);
});

test('cli usage errors return 2', () => {
  for (const argv of [[], ['1', '2'], ['1', '--bogus'], ['x', '--var', 'x'], ['x', '--var', 'x=abc'], ['x', '--var'], ['x', '--var', '1x=2']]) {
    const r = run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.equal(r.err, USAGE, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
  }
});
