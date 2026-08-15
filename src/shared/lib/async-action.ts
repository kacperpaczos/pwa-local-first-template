/**
 * Wraps an async handler with the busy/error signal shell repeated across
 * every "run an action, show a spinner, surface a friendly error" flow in
 * the settings and AI UI: clear the error, flip busy on, run, catch into a
 * formatted error message, flip busy off. The wrapped `fn` still owns its
 * own success-path side effects (status text, toasts) — this only removes
 * the boilerplate around it.
 */
export function createAsyncAction<Args extends unknown[]>(
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  fn: (...args: Args) => Promise<void>,
  formatError: (error: unknown) => string = (error) =>
    error instanceof Error ? error.message : String(error),
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    setError(null);
    setBusy(true);
    try {
      await fn(...args);
    } catch (error) {
      setError(formatError(error));
    } finally {
      setBusy(false);
    }
  };
}
