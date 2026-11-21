import { CalcError } from './errors.mjs';

const FUNCTIONS = {
  min: { arity: [1, Infinity], fn: (...a) => Math.min(...a) },
  max: { arity: [1, Infinity], fn: (...a) => Math.max(...a) },
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  abs: { arity: [1, 1], fn: Math.abs },
};

function finite(n, pos) {
  if (!Number.isFinite(n)) throw new CalcError('result is not a finite number', pos);
  return n;
}

export function evaluate(tree, vars = {}) {
  switch (tree.kind) {
    case 'num':
      return tree.value;
    case 'var':
      if (!Object.hasOwn(vars, tree.name)) throw new CalcError(`unknown variable: ${tree.name}`, tree.pos);
      return vars[tree.name];
    case 'unary': {
      const v = evaluate(tree.arg, vars);
      return tree.op === '-' ? -v : v;
    }
    case 'call': {
      if (!Object.hasOwn(FUNCTIONS, tree.name)) throw new CalcError(`unknown function: ${tree.name}`, tree.pos);
      const { arity, fn } = FUNCTIONS[tree.name];
      if (tree.args.length < arity[0] || tree.args.length > arity[1]) {
        throw new CalcError(`${tree.name} called with ${tree.args.length} arguments`, tree.pos);
      }
      return finite(fn(...tree.args.map((a) => evaluate(a, vars))), tree.pos);
    }
    case 'binary': {
      const a = evaluate(tree.left, vars);
      const b = evaluate(tree.right, vars);
      const r = { '+': a + b, '-': a - b, '*': a * b, '/': a / b, '%': a % b, '^': a ** b }[tree.op];
      return finite(r, tree.pos);
    }
    default:
      throw new Error(`bad tree node ${tree.kind}`);
  }
}
