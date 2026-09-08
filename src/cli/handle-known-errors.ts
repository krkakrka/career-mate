type ErrorClass = new (...args: never[]) => Error;

/**
 * Runs a command action, catching any of the given "known" repository error
 * types (DuplicateError, NotFoundError, ...): prints the message, sets a
 * non-zero exit code, and returns cleanly. Anything else is rethrown so it
 * surfaces as a real crash rather than a silently swallowed exit-code-1 —
 * the trap a hand-copied try/catch is one missing `throw error` away from.
 */
export function reportKnownErrors(knownErrors: ErrorClass[], action: () => void): void {
  try {
    action();
  } catch (error) {
    if (knownErrors.some((ErrorType) => error instanceof ErrorType)) {
      console.error((error as Error).message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
