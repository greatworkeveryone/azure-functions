import { createHash } from "node:crypto";
import type { Connection } from "tedious";
import { parseDirectorThreshold } from "./approvalAuthority-db";
import { executeQuery } from "./db";
export const PACK_VERSION = "stage-1-controls-2026-10-18";
export const CONTROLS_MATRIX = [
  { rule: "Approval authority and separation of duties", enforcement: "approvalAuthority.ts; invoices.ts; quotes.ts", proof: "approvalAuthority.test.ts; invoices.money.test.ts", evidence: "Decision ledger: quote/invoice approvals and denied attempts" },
  { rule: "Price-rise margin, cap and manager authority", enforcement: "moneyRules.ts; moneyVariance-db.ts", proof: "moneyVariance.test.ts; moneyVariance-db.test.ts", evidence: "Decision ledger: po.variance / invoice.variance and overrides" },
  { rule: "Open attribution disputes block outgoing POs", enforcement: "attributionDispute.ts; purchaseOrders.ts; myob/send.ts", proof: "attributionDispute.test.ts", evidence: "For you: quote.attribution_disputed / po.variance_disputed" },
  { rule: "Every MYOB call is logged; test and real RP files are guarded", enforcement: "myob-client.ts; myob/send.ts; test-data.ts", proof: "myob/send.test.ts; myob-client.test.ts", evidence: "MYOB activity: calls and proposals, correlation IDs" },
  { rule: "No automatic MYOB payment creation", enforcement: "Payments remain explicit Floorplan records; MYOB readback never creates one", proof: "myob/readback.test.ts", evidence: "Decision ledger: payments; MYOB readback observations" },
  { rule: "Approvals above threshold require money-action step-up when configured", enforcement: "moneyGate.ts; money-gated-routes.ts", proof: "src/__tests__/moneyGate.test.ts", evidence: "Money-action refusals and access events; network configuration requires Area9" },
];
export type DirectorThresholdSource = "env" | "none" | "stored" | "stored_invalid";

/**
 * The director threshold the backend enforces, and where it came from. This is
 * loadDirectorThreshold's rule (approvalAuthority-db.ts), the one /getApprovalLimits
 * and the approval gate both use, applied to the facts already read for the pack:
 * a stored fact decides when there is one (a stored value that is not a number > 0
 * is ignored, which leaves the threshold derived from the limits, not the env
 * setting); with no stored fact, a valid DIRECTOR_APPROVAL_THRESHOLD applies; else null.
 * A test pins the two against each other.
 */
export function effectiveDirectorThreshold(
  facts: readonly { FactKey?: unknown; FactValue?: unknown }[],
  env: string | undefined = process.env.DIRECTOR_APPROVAL_THRESHOLD,
): { source: DirectorThresholdSource; value: number | null } {
  const stored = facts.find(row => row.FactKey === "director_approval_threshold");
  if (stored) {
    const value = parseDirectorThreshold(String(stored.FactValue));
    return value === null ? { source: "stored_invalid", value: null } : { source: "stored", value };
  }
  const value = parseDirectorThreshold(env);
  return value === null ? { source: "none", value: null } : { source: "env", value };
}

export async function financeControlsSnapshot(connection: Connection) {
  const limits = await executeQuery(connection, "SELECT RoleName, MaxApprovalAmount FROM dbo.ApprovalLimits WITH (HOLDLOCK) ORDER BY RoleName");
  const facts = await executeQuery(connection, "SELECT FactKey, FactValue FROM dbo.ApprovalFacts WITH (HOLDLOCK) ORDER BY FactKey");
  const threshold = effectiveDirectorThreshold(facts);
  const snapshot = { packVersion: PACK_VERSION, matrix: CONTROLS_MATRIX, limits, facts,
    directorThreshold: threshold.value, directorThresholdSource: threshold.source,
    myobWritesEnabled: process.env.MYOB_WRITES_ENABLED === "true",
    attributedApprovalEnabled: process.env.ATTRIBUTED_APPROVAL_ENABLED === "true",
    moneyNetworksConfigured: Boolean(process.env.MONEY_ALLOWED_CIDRS?.trim()) };
  return { snapshot, controlsHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}
