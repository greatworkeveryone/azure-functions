/** A caught value's message, for logs and error bodies. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
