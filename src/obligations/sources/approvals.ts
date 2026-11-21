// Things held for a person's yes that are not a job: a large send (broadcast), a procedure sent to a director, a
// MYOB proposal for the CFO, a pending grant of a privileged role, and a changed contractor email or ABN. Each
// checks the capability its own action's gate is built from, and never the person who asked: for them it is Waiting.

import { executeQuery, type SqlRow } from "../../db";
import { holdEndsAt } from "../../contractorContactHold";
import type { Candidate, SourceAdapter } from "../types";
import { holds, iso, sameText, text } from "../util";

export interface ApprovalFacts {
  broadcasts: SqlRow[];
  contacts: SqlRow[];
  grants: SqlRow[];
  procedures: SqlRow[];
  proposals: SqlRow[];
}

export const approvalsSource: SourceAdapter<ApprovalFacts> = {
  name: "approvals",
  async load(connection) {
    return {
      broadcasts: await executeQuery(connection, `SELECT TOP (100) CorrespondenceId, Subject, RecipientCount, CreatedByOid, CreatedByName, CreatedAt FROM dbo.Correspondence WHERE Status = 'awaiting_approval' ORDER BY CorrespondenceId`),
      contacts: await executeQuery(connection, `SELECT TOP (100) ContractorID, ContractorName, ContactChangedAt, ContactChangedBy, ContactChangedByOid FROM dbo.Contractors WHERE ContactChangedAt IS NOT NULL AND ContactConfirmedAt IS NULL ORDER BY ContractorID`),
      grants: await executeQuery(connection, `SELECT TOP (100) g.GrantID, g.TargetUserID, g.RequestedRole, g.RequestedByOid, g.RequestedByName, g.RequestedAt, u.DisplayName AS TargetName, u.EntraOid AS TargetOid FROM dbo.PendingRoleGrants g JOIN dbo.AppUsers u ON u.UserID = g.TargetUserID WHERE g.Status = N'pending' ORDER BY g.GrantID`),
      procedures: await executeQuery(connection, `SELECT TOP (100) v.Slug, v.Title, v.ApprovalRequestedAt, v.ApprovalRequestedBy, v.ApprovalRequestedFromUserId, v.ApprovalRequestedFromName FROM dbo.ProcedureVersions v WHERE v.Status = 'draft' AND v.ApprovalRequestedAt IS NOT NULL ORDER BY v.ApprovalRequestedAt`),
      proposals: await executeQuery(connection, `SELECT TOP (100) ProposalId, Operation, SubjectType, SubjectId, JobId, ProposedBy, ProposedByOid, ProposedAt FROM dbo.MyobProposals WHERE State = N'proposed' ORDER BY ProposalId`),
    };
  },
  derive(facts, viewer, ctx) {
    const out: Candidate[] = [];
    const add = (c: Omit<Candidate, "chasedNext" | "dueAt" | "key" | "place"> & { dueAt?: string | null }): void => {
      out.push({ chasedNext: null, dueAt: null, key: c.id, place: null, ...c });
    };
    for (const row of facts.broadcasts) {
      const own = viewer.oid !== null && row.CreatedByOid === viewer.oid;
      const canAct = !own && holds(viewer, "approveEmail");
      if (!canAct && !own) continue;
      const count = Number(row.RecipientCount ?? 0);
      add({ canAct, from: text(row.CreatedByName), group: canAct ? "decide" : "waiting", id: `broadcast:${row.CorrespondenceId}`, kind: "broadcast", link: `/broadcast?send=${row.CorrespondenceId}`, subject: `Send to ${count} ${count === 1 ? "recipient" : "recipients"} · ${text(row.Subject) ?? "Untitled send"}`, verb: canAct ? "Approve send" : "Waiting for approval", waitingSince: iso(row.CreatedAt), with: canAct ? null : "a manager or director" });
    }
    for (const row of facts.procedures) {
      const asked = viewer.userId !== null && Number(row.ApprovalRequestedFromUserId) === viewer.userId;
      const own = sameText(text(row.ApprovalRequestedBy), viewer.name);
      const canAct = asked && holds(viewer, "approveProcedures");
      if (!canAct && !own) continue;
      add({ canAct, from: text(row.ApprovalRequestedBy), group: canAct ? "decide" : "waiting", id: `procedure:${row.Slug}`, kind: "procedure", link: `/procedures/${encodeURIComponent(String(row.Slug))}/edit`, subject: `Procedure · ${text(row.Title) ?? String(row.Slug)}`, verb: canAct ? "Approve procedure" : "Waiting for approval", waitingSince: iso(row.ApprovalRequestedAt), with: canAct ? null : text(row.ApprovalRequestedFromName) });
    }
    for (const row of facts.proposals) {
      const own = viewer.oid !== null && row.ProposedByOid === viewer.oid;
      const canAct = !own && holds(viewer, "myobController");
      if (!canAct && !own) continue;
      add({ canAct, from: text(row.ProposedBy), group: canAct ? "decide" : "waiting", id: `myob_proposal:${row.ProposalId}`, kind: "myob_proposal", link: "/admin/myob", subject: `MYOB proposal · ${String(row.Operation).replace(/_/g, " ")} ${String(row.SubjectType).replace(/_/g, " ")} #${row.SubjectId}`, verb: canAct ? "Review MYOB proposal" : "Waiting for the CFO", waitingSince: iso(row.ProposedAt), with: canAct ? null : "the CFO" });
    }
    for (const row of facts.grants) {
      const own = viewer.oid !== null && row.RequestedByOid === viewer.oid;
      const aboutMe = viewer.oid !== null && row.TargetOid === viewer.oid;
      const canAct = !own && !aboutMe && holds(viewer, "decideRoleGrant");
      if (!canAct && !own) continue;
      add({ canAct, from: text(row.RequestedByName), group: canAct ? "decide" : "waiting", id: `role_grant:${row.GrantID}`, kind: "role_grant", link: "/admin/users", subject: `${text(row.TargetName) ?? "A person"} to become ${String(row.RequestedRole).replace(/_/g, " ")}`, verb: canAct ? "Confirm role" : "Waiting for a second person", waitingSince: iso(row.RequestedAt), with: canAct ? null : "a director or another admin" });
    }
    for (const row of facts.contacts) {
      const changed = row.ContactChangedAt instanceof Date ? row.ContactChangedAt : null;
      if (changed && holdEndsAt(changed).getTime() <= ctx.now.getTime()) continue;
      const own = viewer.oid !== null && row.ContactChangedByOid === viewer.oid;
      const canAct = !own && holds(viewer, "confirmContractorContact");
      if (!canAct && !own) continue;
      add({ canAct, from: text(row.ContactChangedBy), group: canAct ? "decide" : "waiting", id: `contractor_contact:${row.ContractorID}`, kind: "contractor_contact", link: `/contractors?contractorId=${row.ContractorID}`, subject: `Changed email or ABN · ${text(row.ContractorName) ?? "a contractor"}`, verb: canAct ? "Confirm contact change" : "Waiting for a second person", waitingSince: iso(changed), with: canAct ? null : "an accounts manager" });
    }
    return out;
  },
};
