// How the report names and describes a contractor, from what load.ts read. Pure.

import type { SqlRow } from "../db";
import type { ComplianceContractor } from "./types";

const isTrue = (value: unknown): boolean => value === true || value === 1;

/**
 * Active and not suspended is the standard the coverage form applies to a new
 * assignment (saveMaintenanceCoverage), so it is the one that counts here.
 */
export function standingOf(row: SqlRow | undefined): ComplianceContractor["standing"] {
  if (!row) return "inactive";
  if (isTrue(row.Suspended)) return "suspended";
  return isTrue(row.Active) ? "active" : "inactive";
}

export function toContractor(contractorId: number, row: SqlRow | undefined): ComplianceContractor {
  const name = typeof row?.ContractorName === "string" ? row.ContractorName.trim() : "";
  return { contractorId, name: name || `Contractor #${contractorId}`, standing: standingOf(row) };
}

export const compareContractors = (a: ComplianceContractor, b: ComplianceContractor): number =>
  a.name.localeCompare(b.name, "en-AU") || a.contractorId - b.contractorId;
