/** SQL Server unique-index (2601) and unique-constraint (2627) violations. */
export function isUniqueViolation(error: unknown): boolean {
  const number = (error as { number?: unknown } | null)?.number;
  return number === 2601 || number === 2627;
}
