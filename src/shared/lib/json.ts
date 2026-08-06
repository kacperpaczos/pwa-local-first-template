/** `JSON.parse` with a caller-chosen error message instead of the native `SyntaxError`. */
export function parseJsonOrThrow(text: string, errorMessage: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(errorMessage);
  }
}
