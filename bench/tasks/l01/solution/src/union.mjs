import { ok, fail, issue } from './result.mjs';

export function oneOf(...validators) {
  return {
    parse(input, path = []) {
      for (const v of validators) {
        const r = v.parse(input, path);
        if (r.ok) return ok(r.value);
      }
      return fail([issue(path, 'no alternative matched')]);
    },
  };
}
