import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";
import type { LedgerSubjectType } from "./ledger/types";

// Files that back a quote, purchase order or invoice (D5, database-safety
// rule 1). A file any of them links is relied on: deleteAttachment refuses it
// while a link exists, and detachFromParent refuses to take it off a record
// that has been approved, paid, sent or marked in MYOB. The frontend mirrors
// the same rules (src/helpers/moneyRecordLocks.ts) only to explain a disabled
// button; these are the ones that enforce.

export type MoneyLinkTable = "JobInvoiceAttachments" | "PurchaseOrderAttachments" | "QuoteAttachments";
type MoneyRecordKind = "invoice" | "purchase order" | "quote";

export interface MoneyLink {
  id: number;
  kind: MoneyRecordKind;
  number: string | null;
}

// Every link of one file, or of every file on one job. The invoice links
// table arrives with migration 134 (J9), so it is read only where it exists.
const LINKS_OF_FILE_SQL = `SELECT l.AttachmentID, N'quote' AS Kind, q.QuoteID AS Id, q.QuoteNumber AS Number
  FROM dbo.QuoteAttachments l JOIN dbo.Quotes q ON q.QuoteID = l.QuoteID
 WHERE l.AttachmentID = @Id
UNION ALL
SELECT l.AttachmentID, N'purchase order', po.PurchaseOrderID, po.PONumber
  FROM dbo.PurchaseOrderAttachments l JOIN dbo.PurchaseOrders po ON po.PurchaseOrderID = l.PurchaseOrderID
 WHERE l.AttachmentID = @Id;
IF OBJECT_ID(N'dbo.JobInvoiceAttachments', N'U') IS NOT NULL
  SELECT l.AttachmentID, N'invoice' AS Kind, i.JobInvoiceID AS Id, i.InvoiceNumber AS Number
    FROM dbo.JobInvoiceAttachments l JOIN dbo.JobInvoices i ON i.JobInvoiceID = l.JobInvoiceID
   WHERE l.AttachmentID = @Id;`;
const LINKS_OF_JOB_SQL = `SELECT l.AttachmentID, N'quote' AS Kind, q.QuoteID AS Id, q.QuoteNumber AS Number
  FROM dbo.QuoteAttachments l JOIN dbo.Quotes q ON q.QuoteID = l.QuoteID
  JOIN dbo.Attachments a ON a.Id = l.AttachmentID
 WHERE a.JobID = @JobID
UNION ALL
SELECT l.AttachmentID, N'purchase order', po.PurchaseOrderID, po.PONumber
  FROM dbo.PurchaseOrderAttachments l JOIN dbo.PurchaseOrders po ON po.PurchaseOrderID = l.PurchaseOrderID
  JOIN dbo.Attachments a ON a.Id = l.AttachmentID
 WHERE a.JobID = @JobID;
IF OBJECT_ID(N'dbo.JobInvoiceAttachments', N'U') IS NOT NULL
  SELECT l.AttachmentID, N'invoice' AS Kind, i.JobInvoiceID AS Id, i.InvoiceNumber AS Number
    FROM dbo.JobInvoiceAttachments l JOIN dbo.JobInvoices i ON i.JobInvoiceID = l.JobInvoiceID
    JOIN dbo.Attachments a ON a.Id = l.AttachmentID
   WHERE a.JobID = @JobID;`;

const toLink = (row: Record<string, unknown>): MoneyLink => ({
  id: row.Id as number,
  kind: row.Kind as MoneyRecordKind,
  number: (row.Number as string | null) ?? null,
});

export const linkLabel = (link: MoneyLink) => `${link.kind} ${link.number ?? `#${link.id}`}`;

export async function moneyLinksOf(connection: Connection, attachmentId: number): Promise<MoneyLink[]> {
  const rows = await executeQuery(connection, LINKS_OF_FILE_SQL, [{ name: "Id", type: TYPES.Int, value: attachmentId }]);
  return rows.map(toLink);
}

/** Attachment id → labels of the money records it is attached to. */
export async function moneyLinksOfJob(connection: Connection, jobId: number): Promise<Map<number, string[]>> {
  const rows = await executeQuery(connection, LINKS_OF_JOB_SQL, [{ name: "JobID", type: TYPES.Int, value: jobId }]);
  const byFile = new Map<number, string[]>();
  for (const row of rows) {
    const id = row.AttachmentID as number;
    byFile.set(id, [...(byFile.get(id) ?? []), linkLabel(toLink(row))]);
  }
  return byFile;
}

const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export function linkedFileRefusal(links: MoneyLink[]): string {
  return `This file is attached to ${listOf(links.map(linkLabel))}, so it can't be deleted. Take it off there first.`;
}

// Why a record's files are fixed, read in the same batch as the link (UPDLOCK
// on record and link, inside the caller's transaction). Null: still open.
// A record pushed to MYOB through the proposal flow (M3, migration 126) never
// gets MyobCreatedAt, so MyobProposals is read too — only where the table
// exists, so the rule works before 126 is applied (@MyobState stays NULL).
export const DETACH_SQL: Record<MoneyLinkTable, string> = {
  JobInvoiceAttachments: `DECLARE @MyobState NVARCHAR(16) = NULL;
IF OBJECT_ID(N'dbo.MyobProposals', N'U') IS NOT NULL
  SELECT TOP 1 @MyobState = mp.State FROM dbo.MyobProposals mp
   WHERE mp.SubjectType = N'invoice' AND mp.SubjectId = @ParentID AND mp.State IN (N'approved', N'pushed', N'verified')
   ORDER BY CASE mp.State WHEN N'verified' THEN 0 WHEN N'pushed' THEN 1 ELSE 2 END;
SELECT r.JobID, r.InvoiceNumber AS Number, a.OriginalName AS FileName,
       CASE WHEN l.AttachmentID IS NULL THEN 0 ELSE 1 END AS Linked,
       CASE WHEN EXISTS (SELECT 1 FROM dbo.Payments p WHERE p.JobInvoiceID = r.JobInvoiceID AND p.Status = N'paid') THEN N'paid'
            WHEN r.MyobCreatedAt IS NOT NULL THEN N'marked in MYOB'
            WHEN @MyobState IN (N'pushed', N'verified') THEN N'sent to MYOB'
            WHEN @MyobState = N'approved' THEN N'approved for MYOB'
            WHEN r.Status = N'director_approved' THEN N'approved by a director'
            WHEN r.Status = N'approved' THEN N'approved'
            WHEN r.Status = N'awaiting_approval' THEN N'sent for approval' END AS LockedBecause
  FROM dbo.JobInvoices r WITH (UPDLOCK, HOLDLOCK)
  LEFT JOIN dbo.JobInvoiceAttachments l WITH (UPDLOCK, HOLDLOCK) ON l.JobInvoiceID = r.JobInvoiceID AND l.AttachmentID = @AttachmentID
  LEFT JOIN dbo.Attachments a ON a.Id = @AttachmentID
 WHERE r.JobInvoiceID = @ParentID;`,
  PurchaseOrderAttachments: `DECLARE @MyobState NVARCHAR(16) = NULL;
IF OBJECT_ID(N'dbo.MyobProposals', N'U') IS NOT NULL
  SELECT TOP 1 @MyobState = mp.State FROM dbo.MyobProposals mp
   WHERE mp.SubjectType = N'purchase_order' AND mp.SubjectId = @ParentID AND mp.State IN (N'approved', N'pushed', N'verified')
   ORDER BY CASE mp.State WHEN N'verified' THEN 0 WHEN N'pushed' THEN 1 ELSE 2 END;
SELECT r.JobID, r.PONumber AS Number, a.OriginalName AS FileName,
       CASE WHEN l.AttachmentID IS NULL THEN 0 ELSE 1 END AS Linked,
       CASE WHEN EXISTS (SELECT 1 FROM dbo.Payments p WHERE p.PurchaseOrderID = r.PurchaseOrderID AND p.Status = N'paid') THEN N'paid'
            WHEN r.MyobCreatedAt IS NOT NULL THEN N'marked in MYOB'
            WHEN @MyobState IN (N'pushed', N'verified') THEN N'sent to MYOB'
            WHEN @MyobState = N'approved' THEN N'approved for MYOB'
            WHEN r.CompletedAt IS NOT NULL THEN N'marked complete'
            WHEN r.SentAt IS NOT NULL THEN N'sent to the contractor' END AS LockedBecause
  FROM dbo.PurchaseOrders r WITH (UPDLOCK, HOLDLOCK)
  LEFT JOIN dbo.PurchaseOrderAttachments l WITH (UPDLOCK, HOLDLOCK) ON l.PurchaseOrderID = r.PurchaseOrderID AND l.AttachmentID = @AttachmentID
  LEFT JOIN dbo.Attachments a ON a.Id = @AttachmentID
 WHERE r.PurchaseOrderID = @ParentID;`,
  QuoteAttachments: `DECLARE @MyobState NVARCHAR(16) = NULL;
IF OBJECT_ID(N'dbo.MyobProposals', N'U') IS NOT NULL
  SELECT TOP 1 @MyobState = mp.State FROM dbo.MyobProposals mp
   WHERE mp.SubjectType = N'quote' AND mp.SubjectId = @ParentID AND mp.State IN (N'approved', N'pushed', N'verified')
   ORDER BY CASE mp.State WHEN N'verified' THEN 0 WHEN N'pushed' THEN 1 ELSE 2 END;
SELECT r.JobID, r.QuoteNumber AS Number, a.OriginalName AS FileName,
       CASE WHEN l.AttachmentID IS NULL THEN 0 ELSE 1 END AS Linked,
       CASE WHEN EXISTS (SELECT 1 FROM dbo.Payments p WHERE p.QuoteID = r.QuoteID AND p.Status = N'paid') THEN N'paid'
            WHEN @MyobState IN (N'pushed', N'verified') THEN N'sent to MYOB'
            WHEN @MyobState = N'approved' THEN N'approved for MYOB'
            WHEN r.Status = N'completed' THEN N'completed'
            WHEN r.Status = N'approved' AND r.DirectorApprovedAt IS NOT NULL THEN N'approved by a director'
            WHEN r.Status = N'approved' THEN N'approved'
            WHEN r.Status = N'awaiting_director' THEN N'sent to a director for approval' END AS LockedBecause
  FROM dbo.Quotes r WITH (UPDLOCK, HOLDLOCK)
  LEFT JOIN dbo.QuoteAttachments l WITH (UPDLOCK, HOLDLOCK) ON l.QuoteID = r.QuoteID AND l.AttachmentID = @AttachmentID
  LEFT JOIN dbo.Attachments a ON a.Id = @AttachmentID
 WHERE r.QuoteID = @ParentID;`,
};

const RECORD: Record<MoneyLinkTable, { kind: MoneyRecordKind; subject: LedgerSubjectType }> = {
  JobInvoiceAttachments: { kind: "invoice", subject: "invoice" },
  PurchaseOrderAttachments: { kind: "purchase order", subject: "purchase_order" },
  QuoteAttachments: { kind: "quote", subject: "quote" },
};

export interface DetachTarget {
  fileName: string | null;
  jobId: number;
  kind: MoneyRecordKind;
  linked: boolean;
  lockedBecause: string | null;
  number: string | null;
  subject: LedgerSubjectType;
}

export function isMoneyLinkTable(table: string): table is MoneyLinkTable {
  return table in RECORD;
}

/** The record's state and the link, locked until the caller's transaction
 *  ends. Null when the record doesn't exist. */
export async function readDetachTarget(
  connection: Connection,
  table: MoneyLinkTable,
  parentId: number,
  attachmentId: number,
): Promise<DetachTarget | null> {
  const [row] = await executeQuery(connection, DETACH_SQL[table], [
    { name: "ParentID", type: TYPES.Int, value: parentId },
    { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
  ]);
  if (!row) return null;
  return {
    fileName: (row.FileName as string | null) ?? null,
    jobId: row.JobID as number,
    kind: RECORD[table].kind,
    linked: Boolean(row.Linked),
    lockedBecause: (row.LockedBecause as string | null) ?? null,
    number: (row.Number as string | null) ?? null,
    subject: RECORD[table].subject,
  };
}

export function detachRefusal(target: DetachTarget, parentId: number): string {
  const kind = target.kind[0].toUpperCase() + target.kind.slice(1);
  return `${kind} ${target.number ?? `#${parentId}`} has been ${target.lockedBecause}, so its files stay with it.`;
}
