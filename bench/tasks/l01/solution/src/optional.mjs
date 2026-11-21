import { ok } from './result.mjs';

export function optional(validator, options = {}) {
  return {
    parse(input, path = []) {
      if (input === undefined) return ok(Object.hasOwn(options, 'default') ? options.default : undefined);
      return validator.parse(input, path);
    },
  };
}
