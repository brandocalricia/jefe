import { ok, fail, issue } from './result.mjs';

export function string({ min, max, pattern } = {}) {
  return {
    parse(input, path = []) {
      if (input === undefined) return fail([issue(path, 'required')]);
      if (typeof input !== 'string') return fail([issue(path, 'expected string')]);
      if (min !== undefined && input.length < min) return fail([issue(path, 'too short')]);
      if (max !== undefined && input.length > max) return fail([issue(path, 'too long')]);
      if (pattern !== undefined && !new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(input)) {
        return fail([issue(path, 'does not match pattern')]);
      }
      return ok(input);
    },
  };
}
