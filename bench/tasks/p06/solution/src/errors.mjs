// Every error the library throws on purpose is a SlotwiseError with a stable code.
export class SlotwiseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SlotwiseError';
    this.code = code;
  }
}

// Guards the functions that used to take positional arguments: the second argument must be an options object.
export function requireOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlotwiseError('E_LEGACY_CALL', 'positional arguments are no longer supported; pass an options object');
  }
  return value;
}
