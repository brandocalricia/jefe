// One error type for everything the spec says is "raised"; callers switch on `code`.
export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}
