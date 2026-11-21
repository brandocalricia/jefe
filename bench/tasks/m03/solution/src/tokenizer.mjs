import { CalcError } from './errors.mjs';

// token: { type: 'num' | 'id' | 'op', value, pos }; ops are + - * / % ^ ( ) ,
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(text.slice(i));
      tokens.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      tokens.push({ type: 'id', value: m[0], pos: i });
      i += m[0].length;
    } else if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
    } else {
      throw new CalcError(`unexpected character "${ch}"`, i);
    }
  }
  return tokens;
}
