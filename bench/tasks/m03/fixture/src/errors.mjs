export class CalcError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}
