// Quotes awaiting approval at every tier, the director tier included. A quote counts while its job is at Awaiting
// Approval (approving one quote leaves the job's other pending quotes behind, and those wait on nobody). Whether the
// viewer may approve comes from the approval-authority core (canApprove), the same function the action calls; the
// person who added a quote does not approve it (a director excepted), so for them it is a thing they are waiting on.

import { executeQuery, type SqlRow } from "../../db";
import { jobKindOf, runsContractorFlow } from "../../jobKinds";
import { approvalStage, approverWords, mayApprove, type ApprovalSubjectFacts } from "../approvalStage";
import type { Candidate, SourceAdapter } from "../types";
import { addedByViewer, iso, num, text } from "../util";

const SQL = `SELECT TOP (1000) q.QuoteID, q.JobID, q.Amount, q.Status, q.CreatedAt, q.CreatedBy, q.CreatedByOid, q.QuoteNumber, q.ContractorName,
       j.Title, j.Kind, j.BuildingID, b.BuildingName
  FROM dbo.Quotes q
  JOIN dbo.Jobs j ON j.JobID = q.JobID
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
 WHERE q.Status IN (N'pending', N'awaiting_approval', N'awaiting_director')
   AND j.Status = N'Awaiting Approval' AND j.IsArchived = 0 AND q.IsTest = 0 AND j.IsTest = 0
 ORDER BY q.CreatedAt, q.QuoteID`;

export const quotesSource: SourceAdapter<SqlRow[]> = {
  name: "quotes",
  load: (connection) => executeQuery(connection, SQL),
  derive(rows, viewer, ctx) {
    const out: Candidate[] = [];
    for (const row of rows) {
      if (!runsContractorFlow(jobKindOf(row.Kind))) continue;
      const facts: ApprovalSubjectFacts = { amount: num(row.Amount), buildingId: num(row.BuildingID), jobId: Number(row.JobID), status: String(row.Status), subject: "quote" };
      if (approvalStage(facts, ctx.authority) === null) continue;
      const added = addedByViewer(viewer, row.CreatedByOid, row.CreatedBy);
      const mine = added || text(row.CreatedBy)?.toLowerCase() === viewer.name.toLowerCase();
      const canAct = !added && mayApprove(viewer, facts, ctx.authority);
      if (!canAct && !mine) continue;
      const number = text(row.QuoteNumber) ?? `#${row.QuoteID}`;
      out.push({
        canAct,
        chasedNext: null,
        dueAt: null,
        from: text(row.CreatedBy),
        group: canAct ? "decide" : "waiting",
        id: `quote:${row.QuoteID}`,
        key: `quote:${row.QuoteID}`,
        kind: "quote",
        link: `/jobs?jobId=${row.JobID}&step=quotes&quoteId=${row.QuoteID}`,
        money: { amount: facts.amount, subject: "quote" },
        place: text(row.BuildingName),
        subject: `Quote ${number}${text(row.ContractorName) ? ` from ${text(row.ContractorName)}` : ""} · Job #${row.JobID}${text(row.Title) ? ` · ${text(row.Title)}` : ""}`,
        verb: canAct ? (approvalStage(facts, ctx.authority) === "director" ? "Approve as director" : "Approve quote") : "Waiting for approval",
        waitingSince: iso(row.CreatedAt),
        with: canAct ? null : approverWords(facts, ctx.authority),
      });
    }
    return out;
  },
};
