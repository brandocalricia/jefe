import { ok, fail, issue } from './result.mjs';

export function object(shape, { strict = false } = {}) {
  return {
    parse(input, path = []) {
      if (input === undefined) return fail([issue(path, 'required')]);
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail([issue(path, 'expected object')]);
      const issues = [];
      const value = {};
      for (const key of Object.keys(shape)) {
        const r = shape[key].parse(Object.hasOwn(input, key) ? input[key] : undefined, [...path, key]);
        if (!r.ok) issues.push(...r.issues);
        else if (r.value !== undefined) value[key] = r.value;
      }
      if (strict) {
        for (const key of Object.keys(input)) {
          if (!Object.hasOwn(shape, key)) issues.push(issue([...path, key], 'unexpected key'));
        }
      }
      return issues.length ? fail(issues) : ok(value);
    },
  };
}
