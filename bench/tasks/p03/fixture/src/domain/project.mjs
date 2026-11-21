import { validation } from './errors.mjs';
import { text } from './validation.mjs';

// Builders return the record without its id; the service allocates the id only after validation
// has passed, so a rejected request never uses up a number.
export function buildProject({ input, actor, now }) {
  const name = text(input?.name, 'name', { max: 80, required: true });
  const description = text(input?.description, 'description', { max: 500 }) ?? '';
  return { name, description, archived: false, createdAt: now, updatedAt: now, createdBy: actor };
}

export function applyProjectPatch(project, patch, now) {
  const next = { ...project };
  const fields = [];
  if (patch?.name !== undefined) {
    next.name = text(patch.name, 'name', { max: 80, required: true });
    fields.push('name');
  }
  if (patch?.description !== undefined) {
    next.description = text(patch.description, 'description', { max: 500 }) ?? '';
    fields.push('description');
  }
  if (fields.length === 0) throw validation('nothing to update');
  next.updatedAt = now;
  return { project: next, fields };
}
