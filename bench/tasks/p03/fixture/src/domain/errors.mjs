// One error type for everything the application rejects on purpose. `code` is stable and is what
// callers (the API layer, the CLI, tests) switch on; `message` is for people.
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export const validation = (message) => new AppError('validation', message);
export const notFound = (what) => new AppError('not_found', `${what} not found`);
export const conflict = (message) => new AppError('conflict', message);
