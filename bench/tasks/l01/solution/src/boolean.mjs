import { ok, fail, issue } from './result.mjs';

export function boolean() {
  return {
    parse(input, path = []) {
      if (input === undefined) return fail([issue(path, 'required')]);
      if (typeof input !== 'boolean') return fail([issue(path, 'expected boolean')]);
      return ok(input);
    },
  };
}
