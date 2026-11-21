// Every error the library throws on purpose is a SlotwiseError with a stable code.
export class SlotwiseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SlotwiseError';
    this.code = code;
  }
}
