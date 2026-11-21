import { AppError } from '../domain/errors.mjs';

const STATUS = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
};

export const ok = (body) => ({ status: 200, body });
export const created = (body) => ({ status: 201, body });
export const noContent = () => ({ status: 204, body: null });

export function errorBody(code, message) {
  return { error: { code, message } };
}

export function fromError(error) {
  if (error instanceof AppError) {
    return { status: STATUS[error.code] ?? 400, body: errorBody(error.code, error.message) };
  }
  return { status: 500, body: errorBody('internal', 'internal error') };
}
