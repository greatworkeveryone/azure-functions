// What a MYOB proposal is about, read from Floorplan: a purchase order (→ a
// MYOB Service Order) or an approved quote (→ a MYOB Service Quote). Only the
// fields MYOB needs, and nothing personal: the line says the reference and the
// Floorplan job number, never a tenant or the job title.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";

export type ProposalSubjectType = "purchase_order" | "quote";

export interface SubjectFacts {
  amount: number | null;
  buildingId: number;
  chargeCode: string | null;
  contractorId: number | null;
  contractorName: string | null;
  description: string;
  jobId: number;
  /** Why it can't go to MYOB as it stands; null when it can. */
  notReady: string | null;
  reference: string | null;
  subjectId: number;
  subjectType: ProposalSubjectType;
}

const QUOTE_READY = new Set(["approved", "completed"]);
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

async function loadPurchaseOrder(connection: Connection, id: number): Promise<SubjectFacts | null> {
  const rows = await executeQuery(
    connection,
    `SELECT po.PurchaseOrderID, po.JobID, po.PONumber, po.ContractorID, po.ContractorName, po.EstimatedCost,
            po.CostNotToExceed, po.ChargeCode, j.BuildingID
       FROM dbo.PurchaseOrders po JOIN dbo.Jobs j ON j.JobID = po.JobID
      WHERE po.PurchaseOrderID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  const row = rows[0];
  if (!row) return null;
  // The order's value is its not-to-exceed ceiling when set, else the estimate (the CFO confirms the basis in the lab).
  const amount = num(row.CostNotToExceed) ?? num(row.EstimatedCost);
  const reference = (row.PONumber as string | null) ?? null;
  return {
    amount,
    buildingId: Number(row.BuildingID),
    chargeCode: (row.ChargeCode as string | null) ?? null,
    contractorId: num(row.ContractorID),
    contractorName: (row.ContractorName as string | null) ?? null,
    description: `${reference ?? "PO"} · Floorplan job #${row.JobID}`,
    jobId: Number(row.JobID),
    notReady: !reference ? "This purchase order has no number yet" : !amount || amount <= 0 ? "This purchase order has no amount" : null,
    reference,
    subjectId: id,
    subjectType: "purchase_order",
  };
}

async function loadQuote(connection: Connection, id: number): Promise<SubjectFacts | null> {
  const rows = await executeQuery(
    connection,
    `SELECT q.QuoteID, q.JobID, q.QuoteNumber, q.ContractorID, q.ContractorName, q.Amount, q.Status, j.BuildingID,
            (SELECT TOP 1 po.ChargeCode FROM dbo.PurchaseOrders po
              WHERE po.JobID = q.JobID AND po.ChargeCode IS NOT NULL ORDER BY po.PurchaseOrderID DESC) AS ChargeCode
       FROM dbo.Quotes q JOIN dbo.Jobs j ON j.JobID = q.JobID
      WHERE q.QuoteID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  const row = rows[0];
  if (!row) return null;
  const amount = num(row.Amount);
  const reference = (row.QuoteNumber as string | null) ?? null;
  const notReady = !QUOTE_READY.has(String(row.Status))
    ? "Only an approved quote can go to MYOB"
    : !reference
      ? "This quote has no number"
      : !amount || amount <= 0
        ? "This quote has no amount"
        : null;
  return {
    amount,
    buildingId: Number(row.BuildingID),
    chargeCode: (row.ChargeCode as string | null) ?? null,
    contractorId: num(row.ContractorID),
    contractorName: (row.ContractorName as string | null) ?? null,
    description: `${reference ?? "Quote"} · Floorplan job #${row.JobID}`,
    jobId: Number(row.JobID),
    notReady,
    reference,
    subjectId: id,
    subjectType: "quote",
  };
}

export function loadSubject(connection: Connection, type: ProposalSubjectType, id: number): Promise<SubjectFacts | null> {
  return type === "purchase_order" ? loadPurchaseOrder(connection, id) : loadQuote(connection, id);
}
