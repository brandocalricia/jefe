import { ok, fail, issue } from './result.mjs';

export function number({ min, max, int } = {}) {
  return {
    parse(input, path = []) {
      if (input === undefined) return fail([issue(path, 'required')]);
      if (typeof input !== 'number' || !Number.isFinite(input)) return fail([issue(path, 'expected number')]);
      if (int && !Number.isInteger(input)) return fail([issue(path, 'not an integer')]);
      if (min !== undefined && input < min) return fail([issue(path, 'too small')]);
      if (max !== undefined && input > max) return fail([issue(path, 'too large')]);
      return ok(input);
    },
  };
}
