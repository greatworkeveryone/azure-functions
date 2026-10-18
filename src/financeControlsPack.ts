import { createHash } from "node:crypto";
import type { Connection } from "tedious";
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
export async function financeControlsSnapshot(connection: Connection) {
  const limits = await executeQuery(connection, "SELECT RoleName, MaxApprovalAmount FROM dbo.ApprovalLimits WITH (HOLDLOCK) ORDER BY RoleName");
  const facts = await executeQuery(connection, "SELECT FactKey, FactValue FROM dbo.ApprovalFacts WITH (HOLDLOCK) ORDER BY FactKey");
  const snapshot = { packVersion: PACK_VERSION, matrix: CONTROLS_MATRIX, limits, facts,
    directorThreshold: facts.find(row => row.FactKey === "director_approval_threshold")?.FactValue ?? process.env.DIRECTOR_APPROVAL_THRESHOLD ?? null,
    myobWritesEnabled: process.env.MYOB_WRITES_ENABLED === "true",
    attributedApprovalEnabled: process.env.ATTRIBUTED_APPROVAL_ENABLED === "true",
    moneyNetworksConfigured: Boolean(process.env.MONEY_ALLOWED_CIDRS?.trim()) };
  return { snapshot, controlsHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}
