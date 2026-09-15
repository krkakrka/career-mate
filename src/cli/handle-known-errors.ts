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

/**
 * The async counterpart, for actions that await something.
 *
 * Needed because Commander does not catch a rejected action: the promise
 * escapes to `parseAsync`, the top-level handler in `index.ts` records the
 * run as `unhandled: true`, and the user gets a stack trace where every
 * other command prints one clean line. A mistyped id should not look like a
 * crash, nor pollute the error counts `cm status` and `cm logs` report.
 */
export async function reportKnownErrorsAsync(
  knownErrors: ErrorClass[],
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (knownErrors.some((ErrorType) => error instanceof ErrorType)) {
      console.error((error as Error).message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
