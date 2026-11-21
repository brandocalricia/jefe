import { formatIssues } from './format.mjs';

export class ValidationError extends Error {
  constructor(issues) {
    super(formatIssues(issues));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export function validate(schema, input) {
  return schema.parse(input, []);
}

export function assertValid(schema, input) {
  const r = validate(schema, input);
  if (!r.ok) throw new ValidationError(r.issues);
  return r.value;
}
