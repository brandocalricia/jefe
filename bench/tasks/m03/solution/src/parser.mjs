import { CalcError } from './errors.mjs';

// tree nodes (binary carries the operator's position): { kind: 'num', value } | { kind: 'var', name, pos } | { kind: 'unary', op, arg }
//             | { kind: 'binary', op, left, right } | { kind: 'call', name, args, pos }
export function parse(tokens, text) {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek() && peek().type === 'op' && peek().value === v;
  const fail = (what) => {
    const t = peek();
    throw new CalcError(t ? `unexpected ${what ?? t.value}` : 'unexpected end of input', t ? t.pos : text.length);
  };

  function expression() {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const { value: op, pos } = tokens[i++];
      left = { kind: 'binary', op, pos, left, right: term() };
    }
    return left;
  }

  function term() {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const { value: op, pos } = tokens[i++];
      left = { kind: 'binary', op, pos, left, right: unary() };
    }
    return left;
  }

  function unary() {
    if (isOp('-') || isOp('+')) {
      const op = tokens[i++].value;
      return { kind: 'unary', op, arg: unary() };
    }
    return power();
  }

  function power() {
    const base = primary();
    if (isOp('^')) {
      const { pos } = tokens[i++];
      return { kind: 'binary', op: '^', pos, left: base, right: unary() }; // right-assoc, unary allowed
    }
    return base;
  }

  function primary() {
    const t = peek();
    if (!t) fail();
    if (t.type === 'num') {
      i++;
      return { kind: 'num', value: t.value };
    }
    if (t.type === 'id') {
      i++;
      if (isOp('(')) {
        i++;
        const args = [];
        if (!isOp(')')) {
          args.push(expression());
          while (isOp(',')) {
            i++;
            args.push(expression());
          }
        }
        if (!isOp(')')) fail();
        i++;
        return { kind: 'call', name: t.value, args, pos: t.pos };
      }
      return { kind: 'var', name: t.value, pos: t.pos };
    }
    if (isOp('(')) {
      i++;
      const inner = expression();
      if (!isOp(')')) fail();
      i++;
      return inner;
    }
    return fail();
  }

  const tree = expression();
  if (i < tokens.length) fail();
  return tree;
}
