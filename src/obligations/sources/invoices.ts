// Incoming invoices awaiting approval at every stage (first approval, then the director when the amount needs one),
// and approved invoices and purchase orders waiting to be recorded in MYOB, for the people allowed to record them
// (markInvoiceInMyob, markPurchaseOrderInMyob: the same capability the action's gate is built from).

import { decideAuthority } from "../../approvalAuthority";
import { executeQuery, type SqlRow } from "../../db";
import { jobKindOf, runsContractorFlow } from "../../jobKinds";
import { amountOf, approvalStage, approverWords, mayApprove, type ApprovalSubjectFacts } from "../approvalStage";
import type { Candidate, SourceAdapter } from "../types";
import { addedByViewer, holds, iso, jobTitle, num, text } from "../util";

export interface InvoiceFacts {
  invoices: SqlRow[];
  purchaseOrders: SqlRow[];
}

const INVOICE_SQL = `SELECT TOP (1000) ji.JobInvoiceID, ji.JobID, ji.Direction, ji.Amount, ji.Status, ji.CreatedAt, ji.CreatedBy, ji.CreatedByOid,
       ji.MyobCreatedAt, j.Title, j.Kind, j.BuildingID, b.BuildingName
  FROM dbo.JobInvoices ji
  JOIN dbo.Jobs j ON j.JobID = ji.JobID
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
 WHERE (ji.Status IN (N'pending', N'awaiting_approval') OR (ji.Status IN (N'approved', N'director_approved') AND ji.MyobCreatedAt IS NULL))
   AND j.IsArchived = 0 AND j.Status <> N'Done' AND ji.IsTest = 0 AND j.IsTest = 0
 ORDER BY ji.CreatedAt, ji.JobInvoiceID`;

const PO_SQL = `SELECT TOP (1000) po.PurchaseOrderID, po.JobID, po.PONumber, po.ContractorName, po.EstimatedCost, po.CreatedAt, po.CreatedBy,
       j.Title, j.BuildingID, b.BuildingName
  FROM dbo.PurchaseOrders po
  JOIN dbo.Jobs j ON j.JobID = po.JobID
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
 WHERE po.MyobCreatedAt IS NULL AND j.IsArchived = 0 AND j.Status <> N'Done' AND j.IsTest = 0
 ORDER BY po.CreatedAt, po.PurchaseOrderID`;

export const invoicesSource: SourceAdapter<InvoiceFacts> = {
  name: "invoices",
  async load(connection) {
    return { invoices: await executeQuery(connection, INVOICE_SQL), purchaseOrders: await executeQuery(connection, PO_SQL) };
  },
  derive(facts, viewer, ctx) {
    const out: Candidate[] = [];
    for (const row of facts.invoices) {
      const subject: ApprovalSubjectFacts = { amount: num(row.Amount), buildingId: num(row.BuildingID), jobId: Number(row.JobID), status: String(row.Status), subject: "invoice" };
      const incoming = ((row.Direction as string | null) ?? "incoming") === "incoming";
      const common = {
        chasedNext: null,
        dueAt: null,
        from: text(row.CreatedBy),
        key: `invoice:${row.JobInvoiceID}`,
        kind: "invoice",
        money: { amount: subject.amount, subject: "invoice" as const },
        place: text(row.BuildingName),
        subject: `Invoice · ${jobTitle(row)}`,
        waitingSince: iso(row.CreatedAt),
      };
      const status = String(row.Status);
      if (status === "pending" || status === "awaiting_approval" || (status === "approved" && incoming && approvalStage(subject, ctx.authority) === "director")) {
        if (!incoming || !runsContractorFlow(jobKindOf(row.Kind))) continue;
        const added = addedByViewer(viewer, row.CreatedByOid, row.CreatedBy);
        const canAct = !added && mayApprove(viewer, subject, ctx.authority);
        if (!canAct && !added) continue;
        out.push({
          ...common,
          canAct,
          group: canAct ? "decide" : "waiting",
          id: `invoice:${row.JobInvoiceID}`,
          link: `/jobs?jobId=${row.JobID}&step=invoices&invoiceId=${row.JobInvoiceID}`,
          verb: canAct ? (approvalStage(subject, ctx.authority) === "director" ? "Approve as director" : "Approve invoice") : "Waiting for approval",
          with: canAct ? null : approverWords(subject, ctx.authority),
        });
        continue;
      }
      // Fully approved and not yet keyed into MYOB.
      const route = decideAuthority({ amount: amountOf(subject), buildingId: subject.buildingId ?? 0, jobId: subject.jobId, subject: "invoice" }, ctx.authority);
      const fullyApproved = status === "director_approved" || (status === "approved" && !route.directorRequired);
      if (!fullyApproved || !holds(viewer, "markInvoiceInMyob")) continue;
      out.push({
        ...common,
        canAct: true,
        group: "do",
        id: `myob_invoice:${row.JobInvoiceID}`,
        key: `myob_invoice:${row.JobInvoiceID}`,
        link: `/jobs?jobId=${row.JobID}&step=invoices&invoiceId=${row.JobInvoiceID}`,
        verb: "Record invoice in MYOB",
      });
    }
    if (holds(viewer, "markPurchaseOrderInMyob")) {
      for (const row of facts.purchaseOrders) {
        out.push({
          canAct: true,
          chasedNext: null,
          dueAt: null,
          from: text(row.CreatedBy),
          group: "do",
          id: `myob_po:${row.PurchaseOrderID}`,
          key: `myob_po:${row.PurchaseOrderID}`,
          kind: "purchase_order",
          link: `/jobs?jobId=${row.JobID}&step=po`,
          money: { amount: num(row.EstimatedCost), subject: "purchase_order" },
          place: text(row.BuildingName),
          subject: `Purchase order ${text(row.PONumber) ?? `#${row.PurchaseOrderID}`}${text(row.ContractorName) ? ` to ${text(row.ContractorName)}` : ""} · ${jobTitle(row)}`,
          verb: "Record purchase order in MYOB",
          waitingSince: iso(row.CreatedAt),
        });
      }
    }
    return out;
  },
};
