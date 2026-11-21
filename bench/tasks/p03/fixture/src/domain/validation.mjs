import { validation } from './errors.mjs';

export const USER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isUserId(value) {
  return typeof value === 'string' && USER_ID.test(value);
}

// Reads a text field. Returns the trimmed string, or null when the field is absent or blank and
// not required.
export function text(value, field, { max = Infinity, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validation(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw validation(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw validation(`${field} is required`);
    return null;
  }
  if (trimmed.length > max) throw validation(`${field} must be at most ${max} characters`);
  return trimmed;
}

export function choice(value, field, allowed) {
  if (!allowed.includes(value)) throw validation(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function userId(value, field) {
  if (!isUserId(value)) throw validation(`${field} must be a valid user id`);
  return value;
}

export function isoDate(value, field) {
  const message = `${field} must be a date like 2026-03-01`;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validation(message);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw validation(message);
  return value;
}
