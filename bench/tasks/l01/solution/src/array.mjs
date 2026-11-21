import { ok, fail, issue } from './result.mjs';

export function array(item, { min, max } = {}) {
  return {
    parse(input, path = []) {
      if (input === undefined) return fail([issue(path, 'required')]);
      if (!Array.isArray(input)) return fail([issue(path, 'expected array')]);
      const issues = [];
      if (min !== undefined && input.length < min) issues.push(issue(path, 'too short'));
      if (max !== undefined && input.length > max) issues.push(issue(path, 'too long'));
      const value = [];
      input.forEach((el, i) => {
        const r = item.parse(el, [...path, i]);
        if (r.ok) value.push(r.value);
        else issues.push(...r.issues);
      });
      return issues.length ? fail(issues) : ok(value);
    },
  };
}
