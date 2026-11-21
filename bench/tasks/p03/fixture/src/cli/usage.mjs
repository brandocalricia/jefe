// Thrown by a command when its arguments are wrong. `message` is the whole line to print on the
// error stream; main() turns it into exit code 2.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export const GLOBAL_USAGE = 'usage: trackboard [--data <file>] [--as <user>] <command> [args]';
