export interface CoverageTrade {
  trade: string;
  required: boolean;
  contractorIds: number[];
}
export interface CoverageInput {
  buildingId: number;
  revision: number;
  trades: CoverageTrade[];
}
export function parseCoverageInput(body: Record<string, unknown>): CoverageInput {
  const { buildingId, revision, trades } = body;
  if (
    typeof buildingId !== "number" ||
    !Number.isInteger(buildingId) ||
    !buildingId ||
    Math.abs(buildingId) > 2147483647
  )
    throw new Error("Choose a building");
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0 || revision >= 2147483647)
    throw new Error("Revision required");
  if (!Array.isArray(trades) || trades.length > 50) throw new Error("Use up to 50 trades");
  const seen = new Set<string>();
  const clean = trades.map((value: unknown): CoverageTrade => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid trade");
    const row = value as Record<string, unknown>;
    if (
      typeof row.trade !== "string" ||
      !row.trade.trim() ||
      row.trade.trim().length > 100 ||
      typeof row.required !== "boolean"
    )
      throw new Error("Trade name and required state needed");
    const trade = row.trade.trim();
    const key = trade.toLocaleLowerCase("en-AU");
    if (seen.has(key)) throw new Error("Each trade must appear once");
    seen.add(key);
    if (
      !Array.isArray(row.contractorIds) ||
      row.contractorIds.length > 30 ||
      row.contractorIds.some(
        (id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 2147483647,
      )
    )
      throw new Error("Choose valid contractors");
    return { trade, required: row.required, contractorIds: [...new Set(row.contractorIds)] };
  });
  return { buildingId, revision, trades: clean };
}
