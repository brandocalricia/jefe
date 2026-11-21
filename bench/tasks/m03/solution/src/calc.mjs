import { evaluate } from './evaluate.mjs';
import { parse } from './parser.mjs';
import { tokenize } from './tokenizer.mjs';

export function calc(text, vars = {}) {
  return evaluate(parse(tokenize(text), text), vars);
}
