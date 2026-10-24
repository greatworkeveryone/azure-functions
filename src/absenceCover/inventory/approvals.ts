// Quotes waiting for approval where the absent person is one who may approve them,
// found by the approval-authority core (canApprove), not by a role guess. A quote
// is an item only when nobody else who is in could approve it either (the engine
// drops the rest: see isStranded): the approval queue is shared by role, so it is
// not at risk while a colleague with the authority is in. Moving it tells a person
// who does hold the authority (a notice); it never approves anything.
//
// Money: an unknown amount needs a director (the core says so), and an amount above
// the owner's team threshold is high importance. Due: 16 business hours (two business days) after the
// quote was selected, for want of a deadline on a quote.

import type { Connection } from "tedious";
import { canApprove, type AuthorityFacts } from "../../approvalAuthority";
import { executeQuery } from "../../db";
import { addBusinessHours } from "../../escalation/businessTime";
import { moneyImportance, teamMoneyThreshold } from "../importance";
import type { AbsentPerson, CoverItem } from "../types";
import type { InventoryContext } from "./context";

const QUOTE_WAIT_HOURS = 16;

export async function loadApprovalItems(
  connection: Connection,
  absent: readonly AbsentPerson[],
  context: InventoryContext,
): Promise<CoverItem[]> {
  const facts = context.facts;
  if (absent.length === 0 || facts === null) return [];
  const rows = await executeQuery(
    connection,
    `SELECT q.QuoteID, q.JobID, q.QuoteNumber, q.ContractorName, q.Amount, q.CreatedAt, q.CreatedBy, j.BuildingID, j.Title, b.BuildingName
       FROM dbo.Quotes q
       INNER JOIN dbo.Jobs j ON j.JobID = q.JobID
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
      WHERE q.Status IN (N'awaiting_approval', N'awaiting_director') AND q.IsTest = 0 AND j.IsTest = 0 AND j.IsArchived = 0`,
  );
  const items: CoverItem[] = [];
  for (const row of rows) {
    const amount = row.Amount === null || row.Amount === undefined ? null : Number(row.Amount);
    const buildingId = row.BuildingID === null || row.BuildingID === undefined ? 0 : Number(row.BuildingID);
    const owner = absent.find((person) => canOwn(person, amount, buildingId, facts));
    if (!owner) continue;
    const rated = moneyImportance(amount, teamMoneyThreshold(owner.role, facts.limits));
    const quoteNumber = typeof row.QuoteNumber === "string" ? row.QuoteNumber : `#${row.QuoteID}`;
    const created = row.CreatedAt instanceof Date ? row.CreatedAt : context.now;
    items.push({
      capability: null,
      deepLink: `/jobs?jobId=${row.JobID}&step=quotes`,
      detail: { jobId: Number(row.JobID) },
      dueAt: addBusinessHours(created, QUOTE_WAIT_HOURS, context.holidays),
      id: String(row.QuoteID),
      importance: rated.importance,
      importanceCode: rated.code,
      isTest: false,
      label: `Quote ${quoteNumber}${row.ContractorName ? ` from ${row.ContractorName}` : ""} awaiting approval · Job #${row.JobID} · ${String(row.Title ?? "").trim()}`,
      minRole: null,
      money: { amount, buildingId, createdByName: typeof row.CreatedBy === "string" ? row.CreatedBy : null, subject: "quote" },
      move: "notice",
      ownerUserId: owner.userId,
      personal: false,
      raisedByUserId: null,
      type: "approval",
    });
  }
  return items;
}

function canOwn(person: AbsentPerson, amount: number | null, buildingId: number, facts: AuthorityFacts): boolean {
  return canApprove({ roles: [person.role], userId: person.userId }, { amount: amount ?? Number.NaN, buildingId, subject: "quote" }, facts).allowed;
}
