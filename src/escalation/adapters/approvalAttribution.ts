// The approval_attribution adapter (PLAN §3.7 WP20; LAUNCH-READINESS R2, R13).
// One subject type for both kinds of "a named manager agreed to this":
//
//   quote:<QuoteID>@<JobID>        a plain facilities officer approved a quote
//                                  within their own row, naming the manager
//                                  they discussed it with (Quotes, migration 117)
//   variance:<VarianceID>@<JobID>  a PO or incoming invoice rose within the
//                                  R13 margin on a named manager's say-so
//                                  (MoneyVariances, migration 117)
//
// The job id rides in the subject id so the deep link needs no lookup. Policies
// (seeded by 117): quote.attribution_notice / po.variance_notice go to the
// named manager alone, in the digest, and end once they answer (the sweep ends
// them, condition_cleared, when the row has an answer). The *_disputed policies
// are raised by answerApprovalAttribution when the manager says "I didn't agree
// to this" and stay until a facilities manager or director resolves them.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import type { EscalationAdapter } from "./registry";

export const ATTRIBUTION_SUBJECT_TYPE = "approval_attribution";

export const ATTRIBUTION_POLICIES = {
  quoteDisputed: "quote.attribution_disputed",
  quoteNotice: "quote.attribution_notice",
  varianceDisputed: "po.variance_disputed",
  varianceNotice: "po.variance_notice",
} as const;

export type AttributionKind = "quote" | "variance";

export interface AttributionRef {
  id: number;
  jobId: number;
  kind: AttributionKind;
}

const SUBJECT_ID = /^(quote|variance):(\d+)@(\d+)$/;

export function attributionSubjectId(ref: AttributionRef): string {
  return `${ref.kind}:${ref.id}@${ref.jobId}`;
}

export function parseAttributionSubjectId(subjectId: string): AttributionRef | null {
  const match = subjectId.match(SUBJECT_ID);
  if (!match) return null;
  return { id: Number(match[2]), jobId: Number(match[3]), kind: match[1] as AttributionKind };
}

export const noticePolicy = (kind: AttributionKind): string =>
  kind === "quote" ? ATTRIBUTION_POLICIES.quoteNotice : ATTRIBUTION_POLICIES.varianceNotice;
export const disputedPolicy = (kind: AttributionKind): string =>
  kind === "quote" ? ATTRIBUTION_POLICIES.quoteDisputed : ATTRIBUTION_POLICIES.varianceDisputed;

/** One attribution as the notice, the answer endpoint and the sweep read it. */
export interface AttributionRecord {
  amount: number | null;
  answeredAt: Date | null;
  attributedToName: string | null;
  attributedToUserId: number | null;
  buildingId: number | null;
  /** Who approved (a quote) or edited (a variance). */
  byName: string | null;
  contractorId: number | null;
  contractorName: string | null;
  disputed: boolean;
  jobId: number;
  /** "Quote Q-7" or "Purchase order #12", for the one-line summary. */
  label: string;
  originalAmount: number | null;
  rationale: string | null;
  ref: AttributionRef;
  subjectId: number;
  subjectType: "invoice" | "purchase_order" | "quote";
}

const QUOTE_SELECT = `SELECT q.QuoteID, q.JobID, q.QuoteNumber, q.ContractorID, q.ContractorName, q.Amount, q.ApprovedBy,
         q.ApprovalAttributedToUserID, q.AttributionAnsweredAt, u.DisplayName AS AttributedToName, j.BuildingID
    FROM Quotes q /*LOCK*/
    INNER JOIN Jobs j ON j.JobID = q.JobID
    LEFT JOIN dbo.AppUsers u ON u.UserID = q.ApprovalAttributedToUserID
   WHERE q.QuoteID = @Id`;

const VARIANCE_SELECT = `SELECT v.VarianceID, v.SubjectType, v.SubjectID, v.JobID, v.OriginalAmount, v.NewAmount, v.Rationale,
         v.EditorName, v.AttributedToUserID, v.AttributedToName, v.AnsweredAt, v.Disputed, j.BuildingID,
         COALESCE(po.ContractorID, ji.ContractorID) AS ContractorID, COALESCE(po.ContractorName, ji.ContractorName) AS ContractorName
    FROM dbo.MoneyVariances v /*LOCK*/
    INNER JOIN Jobs j ON j.JobID = v.JobID
    LEFT JOIN PurchaseOrders po ON v.SubjectType = N'purchase_order' AND po.PurchaseOrderID = v.SubjectID
    LEFT JOIN JobInvoices ji ON v.SubjectType = N'invoice' AND ji.JobInvoiceID = v.SubjectID
   WHERE v.VarianceID = @Id`;

const LOCKED = "WITH (UPDLOCK, HOLDLOCK)";
/** The read, locked until commit when `lock` is set. Only server constants are spliced in. */
const sqlFor = (select: string, lock: boolean): string => select.replace("/*LOCK*/", lock ? LOCKED : "");

const money = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const date = (value: unknown): Date | null => (value instanceof Date ? value : value ? new Date(String(value)) : null);

/** The attribution behind a subject, locked until commit when `lock` is set (the answer's transaction). */
export async function loadAttribution(
  connection: Connection,
  ref: Pick<AttributionRef, "id" | "kind">,
  lock = false,
): Promise<AttributionRecord | null> {
  const params = [{ name: "Id", type: TYPES.Int, value: ref.id }];
  if (ref.kind === "quote") {
    const row = (await executeQuery(connection, sqlFor(QUOTE_SELECT, lock), params))[0];
    if (!row) return null;
    const jobId = Number(row.JobID);
    return {
      amount: money(row.Amount),
      answeredAt: date(row.AttributionAnsweredAt),
      attributedToName: (row.AttributedToName as string | null) ?? null,
      attributedToUserId: (row.ApprovalAttributedToUserID as number | null) ?? null,
      buildingId: (row.BuildingID as number | null) ?? null,
      byName: (row.ApprovedBy as string | null) ?? null,
      contractorId: (row.ContractorID as number | null) ?? null,
      contractorName: (row.ContractorName as string | null) ?? null,
      disputed: false,
      jobId,
      label: `Quote ${(row.QuoteNumber as string | null) ?? `#${ref.id}`}`,
      originalAmount: null,
      rationale: null,
      ref: { id: ref.id, jobId, kind: "quote" },
      subjectId: ref.id,
      subjectType: "quote",
    };
  }
  const row = (await executeQuery(connection, sqlFor(VARIANCE_SELECT, lock), params))[0];
  if (!row) return null;
  const jobId = Number(row.JobID);
  const subjectType = row.SubjectType === "invoice" ? "invoice" : "purchase_order";
  return {
    amount: money(row.NewAmount),
    answeredAt: date(row.AnsweredAt),
    attributedToName: (row.AttributedToName as string | null) ?? null,
    attributedToUserId: (row.AttributedToUserID as number | null) ?? null,
    buildingId: (row.BuildingID as number | null) ?? null,
    byName: (row.EditorName as string | null) ?? null,
    contractorId: (row.ContractorID as number | null) ?? null,
    contractorName: (row.ContractorName as string | null) ?? null,
    disputed: row.Disputed === true || row.Disputed === 1,
    jobId,
    label: `${subjectType === "invoice" ? "Invoice" : "Purchase order"} #${Number(row.SubjectID)}`,
    originalAmount: money(row.OriginalAmount),
    rationale: (row.Rationale as string | null) ?? null,
    ref: { id: ref.id, jobId, kind: "variance" },
    subjectId: Number(row.SubjectID),
    subjectType,
  };
}

/** "Job #12 · Quote Q-7 · approved by Fi, agreed with Mo". */
export function attributionSummary(record: AttributionRecord): string {
  const verb = record.ref.kind === "quote" ? "approved" : "raised within the margin";
  const by = record.byName ? ` by ${record.byName}` : "";
  const agreed = record.attributedToName ? `, agreed with ${record.attributedToName}` : "";
  return `Job #${record.jobId} · ${record.label} · ${verb}${by}${agreed}`;
}

/** Unanswered attributions, for the sweep that makes sure each has its notice. A few rows. */
export async function listUnansweredAttributions(connection: Connection): Promise<{ attributedToUserId: number; ref: AttributionRef }[]> {
  const rows = await executeQuery(
    connection,
    `SELECT N'quote' AS Kind, QuoteID AS Id, JobID, ApprovalAttributedToUserID AS UserId
       FROM Quotes WHERE ApprovalAttributedToUserID IS NOT NULL AND AttributionAnsweredAt IS NULL
     UNION ALL
     SELECT N'variance', VarianceID, JobID, AttributedToUserID
       FROM dbo.MoneyVariances WHERE AttributedToUserID IS NOT NULL AND AnsweredAt IS NULL AND DirectorOverride = 0`,
  );
  return (rows ?? []).map((row) => ({
    attributedToUserId: Number(row.UserId),
    ref: { id: Number(row.Id), jobId: Number(row.JobID), kind: row.Kind === "variance" ? "variance" : "quote" },
  }));
}

export const approvalAttributionAdapter: EscalationAdapter = {
  subjectType: ATTRIBUTION_SUBJECT_TYPE,

  deepLink: (subjectId) => {
    const ref = parseAttributionSubjectId(subjectId);
    return ref ? `/jobs?jobId=${ref.jobId}` : "/escalations";
  },

  async isConditionActive(connection, ref) {
    const parsed = parseAttributionSubjectId(ref.subjectId);
    if (!parsed) return false;
    // A dispute stays until a person resolves it; a notice ends with the answer.
    if (ref.policyKey === disputedPolicy(parsed.kind)) return true;
    const record = await loadAttribution(connection, parsed);
    return record !== null && record.answeredAt === null;
  },

  ledgerScope: (escalation) => ({ jobId: parseAttributionSubjectId(escalation.subjectId)?.jobId ?? null }),

  async loadSummary(connection, subjectId) {
    const ref = parseAttributionSubjectId(subjectId);
    if (!ref) return null;
    const record = await loadAttribution(connection, ref);
    if (!record) return null;
    return {
      buildingId: record.buildingId,
      context: {
        amount: record.amount,
        attributedToName: record.attributedToName,
        attributedToUserId: record.attributedToUserId,
        attributionId: record.ref.id,
        attributionKind: record.ref.kind,
        byName: record.byName,
        contractorName: record.contractorName,
        jobId: record.jobId,
        originalAmount: record.originalAmount,
        rationale: record.rationale,
        recordSubjectId: record.subjectId,
        recordSubjectType: record.subjectType,
      },
      summary: attributionSummary(record),
    };
  },

  // The usual target / raiser / roles-above rule decides; nothing narrows it.
  visibleTo: () => true,
};
