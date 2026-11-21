// One small portfolio, held as the facts every obligations adapter reads, and the eight people who look at it.
// The per-role test asks the same world what each person is waiting on and what is waiting on them.

import type { AuthorityFacts } from "../../approvalAuthority";
import { buildStepFacts } from "../../jobStepFacts";
import { resolveJobStep } from "../../jobStepResolver";
import type { EscalationRow } from "../../escalation/types";
import { makeViewer } from "../../obligations/util";
import type { ObligationContext, Viewer } from "../../obligations/types";
import { approvalsSource } from "../../obligations/sources/approvals";
import { decisionsSource } from "../../obligations/sources/decisions";
import { escalationsSource } from "../../obligations/sources/escalations";
import { intakeSource } from "../../obligations/sources/intake";
import { invoicesSource } from "../../obligations/sources/invoices";
import { jobsSource } from "../../obligations/sources/jobs";
import { leaveSource } from "../../obligations/sources/leave";
import { quotesSource } from "../../obligations/sources/quotes";
import { tenancySource } from "../../obligations/sources/tenancy";
import { timesheetsSource } from "../../obligations/sources/timesheets";
import type { SourceAdapter } from "../../obligations/types";

type Row = Record<string, unknown>;

export const PEOPLE = [
  { id: 1, name: "Pat Plain", oid: "o1", role: "user" },
  { id: 2, name: "Fran Officer", oid: "o2", role: "facilities" },
  { id: 3, name: "Fiona Manager", oid: "o3", role: "facilities_manager" },
  { id: 4, name: "Alex Accounts", oid: "o4", role: "accounts" },
  { id: 5, name: "Anna Manager", oid: "o5", role: "accounts_manager" },
  { id: 6, name: "Cathy Cfo", oid: "o6", role: "cfo" },
  { id: 7, name: "Dan Director", oid: "o7", role: "director" },
  { id: 8, name: "Ada Admin", oid: "o8", role: "admin" },
] as const;

export const ROLES = PEOPLE.map((person) => person.role);

export const AUTHORITY: AuthorityFacts = {
  directorThreshold: 50_000,
  isResidence: false,
  limits: [
    { limit: 2_000, role: "accounts" },
    { limit: 10_000, role: "facilities_manager" },
    { limit: 25_000, role: "accounts_manager" },
    { limit: 50_000, role: "cfo" },
    { limit: null, role: "director" },
  ],
  residenceApprovers: [],
  residenceDirectorFallback: true,
  today: "2026-11-18",
};

export const viewerOf = (role: string): Viewer => {
  const person = PEOPLE.find((p) => p.role === role)!;
  return makeViewer({ email: `${person.oid}@example.test`, name: person.name, oid: person.oid, roles: [role], userId: person.id });
};

const at = (iso: string): Date => new Date(iso);

function escalation(extra: Partial<EscalationRow>): EscalationRow {
  return {
    acknowledgedAt: null, acknowledgedByName: null, acknowledgedByUserId: null, buildingId: null, context: null, createdAt: at("2026-11-10T01:00:00Z"),
    dueAt: at("2026-11-20T01:00:00Z"), escalationId: 0, kind: "attention", lastFollowUpAt: null, lastNotificationAttemptAt: null, lastNotificationError: null,
    lastNotifiedAt: null, level: 1, noIndependentTarget: false, note: null, notificationAttempts: 0, notificationState: "sent", parentEscalationId: null,
    policyKey: "job.manual", raisedByKind: "user", raisedByName: "Fran Officer", raisedByUserId: 2, reason: null, resolutionCode: null, resolutionNote: null,
    resolvedAt: null, resolvedByName: null, resolvedByUserId: null, rowVersion: "AA==", status: "open", subjectId: "10", subjectType: "job",
    summary: "Job #10 needs a decision", targetRole: null, targetUserId: null, updatedAt: at("2026-11-10T01:00:00Z"), urgent: false, ...extra,
  } as EscalationRow;
}

function job(extra: Row, records: { invoices?: Row[]; purchaseOrders?: Row[]; quotes?: Row[]; requested?: Row[] } = {}): Row {
  const base: Row = {
    ApprovedQuoteID: null, AssignedTo: null, AssignedToUserID: null, AwaitingRole: "facilities", BuildingName: "Tower A", CreatedAt: at("2026-11-01T01:00:00Z"),
    ExpectedProgressUpdate: null, IsContract: false, IsInternal: false, JobID: 1, Status: "New", StatusSince: at("2026-11-02T01:00:00Z"), Title: "A job", ...extra,
  };
  const { nextAction, step } = resolveJobStep(buildStepFacts(base, { invoices: [], purchaseOrders: [], quotes: [], requested: [], ...records }, AUTHORITY));
  return { ...base, NextAction: nextAction, Step: step };
}

export function world(): { ctx: ObligationContext; sources: Array<{ adapter: SourceAdapter<unknown>; facts: unknown }> } {
  const ctx: ObligationContext = {
    authority: AUTHORITY,
    directory: PEOPLE.map((p) => ({ email: `${p.oid}@example.test`, name: p.name, role: p.role, userId: p.id })),
    links: [],
    now: at("2026-11-18T03:00:00Z"),
    staff: PEOPLE.map((p) => ({ id: p.id, name: p.name, oid: p.oid, role: p.role })),
    today: "2026-11-18",
  };
  const quote = (id: number, amount: number, status: string): Row => ({ Amount: amount, BuildingID: 1, BuildingName: "Tower A", ContractorName: "Acme", CreatedAt: at("2026-11-12T01:00:00Z"), CreatedBy: "Fran Officer", CreatedByOid: "o2", JobID: 10 + id, Kind: "facilities", QuoteID: id, QuoteNumber: `Q${id}`, Status: status, Title: "Roof" });
  const facts: Record<string, unknown> = {
    approvals: {
      broadcasts: [{ CorrespondenceId: 1, CreatedAt: at("2026-11-13T01:00:00Z"), CreatedByName: "Fran Officer", CreatedByOid: "o2", RecipientCount: 40, Subject: "Water off" }],
      contacts: [{ ContactChangedAt: at("2026-11-17T01:00:00Z"), ContactChangedBy: "Alex Accounts", ContactChangedByOid: "o4", ContractorID: 1, ContractorName: "Acme" }],
      grants: [{ GrantID: 1, RequestedAt: at("2026-11-14T01:00:00Z"), RequestedByName: "Ada Admin", RequestedByOid: "o8", RequestedRole: "director", TargetName: "Fran Officer", TargetOid: "o2", TargetUserID: 2 }],
      procedures: [{ ApprovalRequestedAt: at("2026-11-12T01:00:00Z"), ApprovalRequestedBy: "Fiona Manager", ApprovalRequestedFromName: "Dan Director", ApprovalRequestedFromUserId: 7, Slug: "fire-drill", Title: "Fire drill" }],
      proposals: [{ JobId: null, Operation: "create", ProposalId: 1, ProposedAt: at("2026-11-15T01:00:00Z"), ProposedBy: "Anna Manager", ProposedByOid: "o5", SubjectId: 4, SubjectType: "purchase_order" }],
    },
    decisions: {
      places: new Map([[12, { building: "Tower A", title: "Lift" }]]),
      requests: [{ assignmentMode: "named", decisionMakers: { role: null, userIds: [3] }, jobId: 12, question: "Repair or replace the lift?", requestedAt: at("2026-11-11T01:00:00Z"), requestedBy: "Fran Officer", requestedByUserId: 2, requestId: 1, respondBy: null }],
    },
    escalations: [
      escalation({ escalationId: 101, kind: "authority", policyKey: "finance.dispute", raisedByKind: "system", raisedByName: "Floorplan", raisedByUserId: null, subjectId: "5", subjectType: "invoice", summary: "Invoice dispute on job #5", targetRole: "cfo" }),
      escalation({ escalationId: 102, subjectId: "12", summary: "Job #12 is stalled", targetUserId: 3 }),
    ],
    intake: [{ BuildingName: "Tower A", CreatedAt: at("2026-11-16T01:00:00Z"), Details: "The tap in the kitchen is dripping", ReportedByName: "Pat Plain", ReportedByOid: "o1", WorkRequestID: 1900000001 }],
    invoices: {
      invoices: [
        { Amount: 1800, BuildingID: 1, BuildingName: "Tower A", CreatedAt: at("2026-11-13T01:00:00Z"), CreatedBy: "Alex Accounts", CreatedByOid: "o4", Direction: "incoming", JobID: 20, JobInvoiceID: 1, Kind: "facilities", MyobCreatedAt: null, Status: "pending", Title: "Pipes" },
        { Amount: 900, BuildingID: 1, BuildingName: "Tower A", CreatedAt: at("2026-11-09T01:00:00Z"), CreatedBy: "Alex Accounts", CreatedByOid: "o4", Direction: "incoming", JobID: 21, JobInvoiceID: 2, Kind: "facilities", MyobCreatedAt: null, Status: "approved", Title: "Paint" },
      ],
      purchaseOrders: [{ BuildingName: "Tower A", ContractorName: "Acme", CreatedAt: at("2026-11-08T01:00:00Z"), CreatedBy: "Fiona Manager", EstimatedCost: 700, JobID: 22, PONumber: "PO-1", PurchaseOrderID: 1, Title: "Locks" }],
    },
    jobs: [
      job({ AssignedTo: "Fran Officer", AssignedToUserID: 2, JobID: 12, Title: "Lift" }),
      job({ JobID: 13, Title: "Nobody has this" }),
      job({ AssignedTo: "Fran Officer", AssignedToUserID: 2, JobID: 14, Status: "Quote", Title: "Gutters" }, { requested: [{ RequestSent: true }, { RequestSent: true }] }),
    ],
    leave: [{ CreatedAt: at("2026-11-14T01:00:00Z"), EndDate: "2026-12-05", Kind: "annual_leave", RequestId: 1, StartDate: "2026-12-01", UserId: 1 }],
    quotes: [quote(1, 60_000, "awaiting_director"), quote(2, 1_500, "pending")],
    tenancy: {
      changes: [{ BuildingName: "Tower A", Kind: "area_change", LegalName: "Shop Pty", RequestId: "c1", RequestedAt: at("2026-11-12T01:00:00Z"), RequestedById: 5, RequestedByName: "Anna Manager", TenantId: 1, TradingName: "Shop" }],
      events: [{ BuildingName: "Tower A", LeaseEventId: "e1", LegalName: "Cafe Pty", RecordedAt: at("2026-11-12T01:00:00Z"), RecordedById: 6, RecordedByName: "Cathy Cfo", TenantId: 2, TradingName: "Cafe" }],
      reviews: [{ BuildingName: "Tower A", LegalName: "Shop Pty", PreparedById: 4, PreparedByName: "Alex Accounts", ReviewId: "r1", SubmittedAt: at("2026-11-12T01:00:00Z"), TenantId: 1, TradingName: "Shop" }],
      unsigned: [{ BuildingName: "Tower A", LegalName: "Gym Pty", NextReviewDate: at("2026-12-20T00:00:00Z"), TenantId: 3, TradingName: "Gym" }],
    },
    timesheets: [{ Approved: false, ReadyForApproval: true, ReadyForApprovalDate: at("2026-11-16T01:00:00Z"), Role: "facilities", TimesheetID: 1, UserDisplayName: "Fran Officer", UserID: "o2", WeekStart: "2026-11-09" }],
  };
  const adapters: SourceAdapter<unknown>[] = [approvalsSource, decisionsSource, escalationsSource, intakeSource, invoicesSource, jobsSource, leaveSource, quotesSource, tenancySource, timesheetsSource];
  return { ctx, sources: adapters.map((adapter) => ({ adapter, facts: facts[adapter.name] })) };
}
