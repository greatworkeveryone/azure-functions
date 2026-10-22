export const SERVICE_REGIONS = ["Darwin", "Palmerston", "Katherine"] as const;
export interface ContractorCoverageInput {
  contractorId: number;
  revision: number;
  regions: string[];
  trades: string[];
}
export function parseContractorCoverage(body: Record<string, unknown>): ContractorCoverageInput {
  const { contractorId, revision, regions, trades } = body;
  if (
    typeof contractorId !== "number" ||
    !Number.isInteger(contractorId) ||
    contractorId <= 0 ||
    contractorId > 2147483647
  )
    throw new Error("Choose a contractor");
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0 || revision >= 2147483647)
    throw new Error("Revision required");
  if (!Array.isArray(regions) || regions.some((value) => !SERVICE_REGIONS.includes(value)))
    throw new Error("Choose recognised service regions");
  if (
    !Array.isArray(trades) ||
    trades.length > 50 ||
    trades.some((value) => typeof value !== "string" || !value.trim() || value.trim().length > 100)
  )
    throw new Error("Use up to 50 named trades");
  const clean = trades.map((value: string) => value.trim());
  if (new Set(clean.map((value) => value.toLocaleLowerCase("en-AU"))).size !== clean.length)
    throw new Error("Each trade must appear once");
  return { contractorId, revision, regions: [...new Set(regions)], trades: clean };
}
