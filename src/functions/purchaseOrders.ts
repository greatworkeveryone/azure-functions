// Purchase Orders — CRUD + "send" stub. The send endpoint persists the
// outgoing email metadata and flips SentAt/SentBy; actual PDF generation
// and Microsoft Graph sendMail are follow-on work that plug into the same
// endpoint without schema changes.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  buildUpdateSet,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse, verifiedIdentityFromRequest } from "../auth";
import { requireMoneyContext } from "../moneyGate";
import { resolveRecipient } from "../email-recipient";
import { graphSendMail } from "../graph";
import { renderPurchaseOrderPDF } from "../pdf/purchase-order-pdf";
import { defaultPOEmail } from "../pdf/default-po-email";
import {
  deleteBlob,
  downloadBlob,
  generateReadSasUrl,
  uploadPurchaseOrderPdf,
} from "../blob-storage";
import {
  INTERNAL_ACRONYM,
  ensureContractorAcronym,
} from "../contractor-acronym-db";
import { formatDocNumber } from "../doc-number";
import { resolvePoNumber } from "../po-reference-db";
import { advanceJobStatus } from "../jobStatusHelpers";
import { AwaitingRole, JobEvent, JobStatus } from "../jobStatusMachine";
import { decidePurchaseOrderEdit } from "../edit-effects";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import {
  amountChange,
  amountUnchanged,
  approvedQuoteAmount,
  contractorFacts,
  deletionAfter,
  jobScope,
  purchaseOrderFacts,
  purchaseOrderMarkers,
  purchaseOrderSnapshot,
} from "../ledger/moneyDecisions";
import { recordRefusal, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";
import { parseMoneyField } from "../money";
import type { LedgerActor } from "../ledger/types";

/**
 * Quote-approval guard for PO creation (WP8). Returns an error string if
 * creating a PO would act as implicit quote approval, else null.
 *
 * The machine's PO_CREATED edge moves a job out of (Awaiting Approval,
 * facilities) → Work. That is the only state where creating a PO transitions
 * the job — and createPurchaseOrder is callable by plain accounts, a wider set
 * than the quote-approval authority (approveQuote applies the role approval
 * limit + director routing, and only then stamps Jobs.ApprovedQuoteID). So a
 * PO created in that state with no ApprovedQuoteID would leapfrog the manager
 * approval limit. Block exactly that case; every other state is a no-op
 * transition and proceeds untouched.
 */
export function purchaseOrderApprovalError(job: {
  status: JobStatus;
  awaitingRole: AwaitingRole;
  approvedQuoteId: number | null;
}): string | null {
  const leapfrogsApproval =
    job.status === JobStatus.AWAITING_APPROVAL &&
    job.awaitingRole === AwaitingRole.FACILITIES &&
    job.approvedQuoteId == null;
  if (leapfrogsApproval) {
    return "Cannot create a purchase order — the quote hasn't been approved yet. Approve the quote first (this enforces the approval limit) before raising a PO.";
  }
  return null;
}

const PO_COLUMNS = `
  PurchaseOrderID, JobID, PONumber, Seq, ContractorID, ContractorName,
  Scope, EstimatedCost, CostNotToExceed, CostJustification,
  EmailSubject, EmailBody, PDFBlobName, SentAt, SentBy,
  MyobCreatedAt, MyobCreatedBy, CompletedAt, CompletedBy,
  CreatedAt, CreatedBy, UpdatedAt
`;

// ── GET /api/getPurchaseOrders?jobId=N ───────────────────────────────────────

async function getPurchaseOrders(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.DIRECTOR, AppRole.FACILITIES]);
  if (denied) return denied;

  const jobId = request.query.get("jobId");
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId query param required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE JobID = @JobID ORDER BY Seq ASC`,
      [{ name: "JobID", type: TYPES.Int, value: Number(jobId) }],
    );
    return { status: 200, jsonBody: { count: rows.length, purchaseOrders: rows } };
  } catch (error: any) {
    context.error("getPurchaseOrders failed:", error.message);
    return errorResponse("Failed to fetch purchase orders", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertPurchaseOrder ────────────────────────────────────────────
// Body: {
//   PurchaseOrderID?, JobID (required for create),
//   ContractorID?, ContractorName?, Scope?, EstimatedCost?, CostNotToExceed?,
//   CostJustification?, EmailSubject?, EmailBody?, ChargeCode?
// }
// The actor is the verified caller, never the body.
// On create, PONumber = `{BuildingRef}{ChargeCode}{YYMMDD}` (e.g. 66Sm261013),
// with a b..z suffix on a same-day collision; see po-reference-db.ts. Optional
// body ChargeCode overrides the code derived from the job. A building with no
// ReferenceCode falls back to `{YYMMDD}-PO-{JobID}-{ACR}-{Seq}`.
//   ACR is the contractor's 3-letter acronym (lazy-populated on first use),
//       or "INT" for internal jobs with no contractor.
//   Seq is per-contractor (total POs to this contractor ever + 1),
//       or per-job for internal (no-contractor) jobs.
// Wrapped in a transaction with UPDLOCK/HOLDLOCK on the MAX(Seq) read so
// concurrent creates can't collide on the same seq number. Creating a PO is a
// decision (PLAN §3.12): the same transaction carries its ledger row, so the PO
// and the row commit together or not at all.

interface UpsertPurchaseOrderBody {
  PurchaseOrderID?: number;
  JobID?: number;
  ContractorID?: number;
  ContractorName?: string;
  Scope?: string;
  /** Numbers or typed strings such as "1,500.00"; parsed by parseMoneyField. */
  EstimatedCost?: number | string | null;
  CostNotToExceed?: number | string | null;
  CostJustification?: string;
  EmailSubject?: string;
  EmailBody?: string;
  ChargeCode?: string;
  /** @deprecated ignored — identity comes from the token */
  CreatedBy?: string;
}

// Editing a PO isn't a ledgered decision; only an attempt to create one is
// recorded, against the job it would have been raised for.
const CREATE_PO_TARGET: RefusalTarget = {
  attempted: (body) => (body.PurchaseOrderID === undefined ? "po.create" : null),
  idField: "JobID",
  subjectType: "job",
};

export async function upsertPurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Plain accounts staff create / edit POs alongside facilities managers —
  // approval/send-to-contractor is the gated step, drafting is not.
  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, CREATE_PO_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as UpsertPurchaseOrderBody;
    const {
      PurchaseOrderID,
      JobID,
      ContractorID,
      ContractorName,
      Scope,
      EstimatedCost: rawEstimatedCost,
      CostNotToExceed: rawCostNotToExceed,
      CostJustification,
      EmailSubject,
      EmailBody,
      ChargeCode,
    } = body ?? {};
    const estimated = parseMoneyField(rawEstimatedCost, "EstimatedCost");
    if (!estimated.ok) return { status: 400, jsonBody: { error: estimated.error } };
    const cap = parseMoneyField(rawCostNotToExceed, "CostNotToExceed");
    if (!cap.ok) return { status: 400, jsonBody: { error: cap.error } };
    const EstimatedCost = estimated.value;
    const CostNotToExceed = cap.value;

    connection = await createRequestConnection(token);

    if (PurchaseOrderID === undefined) {
      // Create — runs in a tx so the SELECT MAX(Seq) + INSERT pair is atomic
      // and concurrent creates can't claim the same seq number.
      if (typeof JobID !== "number") {
        return { status: 400, jsonBody: { error: "JobID (number) required to create a PO" } };
      }

      const actor = await resolveLedgerActor(request, connection);
      if (!actor) return unauthorizedResponse();

      await beginTransaction(connection);
      try {
        // Quote-approval gate: refuse a PO that would leapfrog an unapproved
        // quote out of (Awaiting Approval, facilities) → Work. Read inside the
        // tx so the state we guard on is the state advanceJobStatus will act
        // on. ApprovedQuoteID is only set once approveQuote has applied the
        // role approval limit + director routing.
        const jobStateRows = await executeQuery(
          connection,
          "SELECT Status, AwaitingRole, ApprovedQuoteID FROM Jobs WHERE JobID = @JobID",
          [{ name: "JobID", type: TYPES.Int, value: JobID }],
        );
        if (jobStateRows.length === 0) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: "Job not found" } };
        }
        const approvalError = purchaseOrderApprovalError({
          status: jobStateRows[0].Status as JobStatus,
          awaitingRole:
            (jobStateRows[0].AwaitingRole as AwaitingRole) ?? AwaitingRole.FACILITIES,
          approvedQuoteId: (jobStateRows[0].ApprovedQuoteID as number | null) ?? null,
        });
        if (approvalError) {
          // A PO that would act as the quote's approval is a refused attempt,
          // ledgered in a transaction of its own now that this one has rolled back.
          await rollbackTransaction(connection).catch(() => {});
          await recordRefusal(
            connection,
            actor,
            { id: JobID, type: "job" },
            {
              attempted: "po.create",
              code: "quote_not_approved",
              message: approvalError,
              state: { jobStatus: String(jobStateRows[0].Status) },
            },
            JobID,
          );
          return { status: 422, jsonBody: { error: approvalError } };
        }

        const acronym =
          typeof ContractorID === "number"
            ? await ensureContractorAcronym(connection, ContractorID)
            : INTERNAL_ACRONYM;

        // Per-contractor seq for normal POs, per-job seq for internal ones.
        // UPDLOCK + HOLDLOCK take a key-range lock over the aggregated set so
        // another session blocks until this tx commits.
        const seqSql =
          typeof ContractorID === "number"
            ? `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq
                 FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK)
                WHERE ContractorID = @ContractorID`
            : `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq
                 FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK)
                WHERE JobID = @JobID AND ContractorID IS NULL`;
        const seqParams =
          typeof ContractorID === "number"
            ? [{ name: "ContractorID", type: TYPES.Int, value: ContractorID }]
            : [{ name: "JobID", type: TYPES.Int, value: JobID }];
        const seqRows = await executeQuery(connection, seqSql, seqParams);
        const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;

        // Johanne's MYOB format (building + charge code + date); the legacy
        // number is only the fallback for a building with no ReferenceCode.
        const po = await resolvePoNumber(connection, {
          jobId: JobID,
          requestedChargeCode: ChargeCode,
          fallbackPoNumber: formatDocNumber({ prefix: "PO", jobId: JobID, acronym, seq: nextSeq }),
        });
        if (po.warning) context.warn(po.warning);
        const poNumber = po.poNumber;

        const inserted = await executeQuery(
          connection,
          `INSERT INTO PurchaseOrders
             (JobID, PONumber, Seq, ContractorID, ContractorName, Scope,
              EstimatedCost, CostNotToExceed, CostJustification,
              EmailSubject, EmailBody, CreatedBy, ChargeCode)
           OUTPUT INSERTED.PurchaseOrderID
           VALUES
             (@JobID, @PONumber, @Seq, @ContractorID, @ContractorName, @Scope,
              @EstimatedCost, @CostNotToExceed, @CostJustification,
              @EmailSubject, @EmailBody, @CreatedBy, @ChargeCode);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "PONumber", type: TYPES.NVarChar, value: poNumber },
            { name: "Seq", type: TYPES.Int, value: nextSeq },
            { name: "ContractorID", type: TYPES.Int, value: ContractorID ?? null },
            { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
            { name: "Scope", type: TYPES.NVarChar, value: Scope ?? null },
            { name: "EstimatedCost", type: TYPES.Decimal, value: EstimatedCost ?? null },
            { name: "CostNotToExceed", type: TYPES.Decimal, value: CostNotToExceed ?? null },
            { name: "CostJustification", type: TYPES.NVarChar, value: CostJustification ?? null },
            { name: "EmailSubject", type: TYPES.NVarChar, value: EmailSubject ?? null },
            { name: "EmailBody", type: TYPES.NVarChar, value: EmailBody ?? null },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            { name: "ChargeCode", type: TYPES.NVarChar, value: po.chargeCode },
          ],
        );
        const newId = inserted[0].PurchaseOrderID as number;

        // First PO insert advances (Awaiting Approval, facilities) → (Work, facilities).
        // No-op if already past that state (subsequent POs, manual moves, etc).
        await advanceJobStatus(connection, JobID, JobEvent.PO_CREATED, {
          actor: identity.name,
          purchaseOrderId: newId,
          note: `PO ${poNumber} created — work in progress.`,
        });

        const scope = await jobScope(connection, JobID);
        await record(connection, {
          action: "po.create",
          actor,
          after: purchaseOrderFacts({
            ContractorID: ContractorID ?? null,
            ContractorName: ContractorName ?? null,
            CostNotToExceed: CostNotToExceed ?? null,
            EstimatedCost: EstimatedCost ?? null,
            PONumber: poNumber,
          }),
          buildingId: scope.buildingId,
          jobId: scope.jobId,
          subject: { id: newId, type: "purchase_order" },
        });

        await commitTransaction(connection);

        const stored = await executeQuery(
          connection,
          `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: newId }],
        );
        return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    }

    // Update
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID must be a number" } };
    }
    const update = buildUpdateSet(
      {
        ContractorID: TYPES.Int,
        ContractorName: TYPES.NVarChar,
        CostJustification: TYPES.NVarChar,
        CostNotToExceed: TYPES.Decimal,
        EmailBody: TYPES.NVarChar,
        EmailSubject: TYPES.NVarChar,
        EstimatedCost: TYPES.Decimal,
        Scope: TYPES.NVarChar,
      },
      {
        ContractorID,
        ContractorName,
        CostJustification,
        CostNotToExceed,
        EmailBody,
        EmailSubject,
        EstimatedCost,
        Scope,
      },
    );
    // UpdatedAt is always bumped on an update — it's a SQL expression, not a
    // user value, so it lives outside the allowlist.
    const setClause = update
      ? `${update.setClause}, UpdatedAt = SYSUTCDATETIME()`
      : "UpdatedAt = SYSUTCDATETIME()";

    // A cost edit can void the sent and MYOB markers, which is a decision (PLAN
    // §3.12): the reset and its ledger row commit together or not at all. Only
    // an edit that carries a cost looks up who is editing.
    let actor: LedgerActor | null = null;
    if (EstimatedCost !== undefined || CostNotToExceed !== undefined) {
      actor = await resolveLedgerActor(request, connection);
      if (!actor) return unauthorizedResponse();
    }

    await beginTransaction(connection);
    try {
      // Read the existing PO before mutating so we can diff for the audit
      // trail and decide whether to clear the Sent / MYOB markers. Locked until
      // commit, so the markers recorded as reset are the ones reset.
      const beforeRows = await executeQuery(
        connection,
        `SELECT PurchaseOrderID, JobID, PONumber, ContractorName,
                EstimatedCost, CostNotToExceed, SentAt, MyobCreatedAt, CompletedAt,
                SentBy, MyobCreatedBy, ContractorID
           FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PurchaseOrderID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
      );
      if (beforeRows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Purchase order not found" } };
      }
      const before = beforeRows[0];
      const jobId = before.JobID as number;
      const poNumber =
        (before.PONumber as string | null) ?? `#${PurchaseOrderID}`;

      const effects = decidePurchaseOrderEdit(
        {
          completedAt: (before.CompletedAt as Date | null) ?? null,
          contractorName: (before.ContractorName as string | null) ?? null,
          costNotToExceed:
            before.CostNotToExceed != null ? Number(before.CostNotToExceed) : null,
          estimatedCost:
            before.EstimatedCost != null ? Number(before.EstimatedCost) : null,
          myobCreatedAt: (before.MyobCreatedAt as Date | null) ?? null,
          sentAt: (before.SentAt as Date | null) ?? null,
        },
        {
          contractorName: ContractorName,
          costNotToExceed: CostNotToExceed,
          estimatedCost: EstimatedCost,
        },
      );

      await executeQuery(
        connection,
        `UPDATE PurchaseOrders SET ${setClause} WHERE PurchaseOrderID = @Id`,
        [
          { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
          ...(update?.params ?? []),
        ],
      );

      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
         VALUES (@JobID, @CreatedBy, @Text, 'po_edited', @POID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          {
            name: "Text",
            type: TYPES.NVarChar,
            value: `Edited PO ${poNumber}: ${effects.summary}`,
          },
          { name: "POID", type: TYPES.Int, value: PurchaseOrderID },
        ],
      );

      // Cost moved while a PDF/email had already gone to the contractor or
      // MYOB had already been told about this PO — the downstream record is
      // now stale. Clear the markers + log it so the user knows to re-send
      // / re-record. (Once Completed we treat dollars as historical and
      // leave markers alone — see decidePurchaseOrderEdit.)
      if (effects.clearSentMarker || effects.clearMyobMarker) {
        const clauses: string[] = [];
        if (effects.clearSentMarker) {
          clauses.push("SentAt = NULL", "SentBy = NULL");
        }
        if (effects.clearMyobMarker) {
          clauses.push("MyobCreatedAt = NULL", "MyobCreatedBy = NULL");
        }
        await executeQuery(
          connection,
          `UPDATE PurchaseOrders SET ${clauses.join(", ")} WHERE PurchaseOrderID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
        );
        const noteParts: string[] = [];
        if (effects.clearSentMarker) noteParts.push("re-send to contractor");
        if (effects.clearMyobMarker) noteParts.push("re-record in MYOB");
        await executeQuery(
          connection,
          `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
           VALUES (@JobID, @CreatedBy, @Text, 'po_markers_cleared', @POID);`,
          [
            { name: "JobID", type: TYPES.Int, value: jobId },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            {
              name: "Text",
              type: TYPES.NVarChar,
              value: `PO ${poNumber} cost changed — please ${noteParts.join(" and ")}.`,
            },
            { name: "POID", type: TYPES.Int, value: PurchaseOrderID },
          ],
        );

        // Only an edit that carries a cost can get here, and those looked up
        // who is editing above.
        if (!actor) throw new Error("PO markers were reset without a ledger actor");
        const cleared = { myob: effects.clearMyobMarker, sent: effects.clearSentMarker };
        const scope = await jobScope(connection, jobId);
        const edited = {
          ...before,
          ContractorID: ContractorID !== undefined ? ContractorID : before.ContractorID,
          ContractorName: ContractorName !== undefined ? ContractorName : before.ContractorName,
          CostNotToExceed: CostNotToExceed !== undefined ? CostNotToExceed : before.CostNotToExceed,
          EstimatedCost: EstimatedCost !== undefined ? EstimatedCost : before.EstimatedCost,
        };
        // An order is measured against the quote approved for its job.
        const approvedQuote = await approvedQuoteAmount(connection, jobId);
        await record(connection, {
          action: "po.markers_reset",
          actor,
          after: {
            ...purchaseOrderFacts(edited),
            ...amountChange({ approved: approvedQuote, next: edited.EstimatedCost, previous: before.EstimatedCost }),
            myobMarkerCleared: cleared.myob,
            sentMarkerCleared: cleared.sent,
          },
          before: purchaseOrderMarkers(before, cleared),
          buildingId: scope.buildingId,
          jobId: scope.jobId,
          subject: { id: PurchaseOrderID, type: "purchase_order" },
        });
      }

      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (stored.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("upsertPurchaseOrder failed:", error.message);
    return errorResponse("Upsert purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/previewPurchaseOrder ───────────────────────────────────────────
// Body: { PurchaseOrderID }
// Renders the PO PDF from current PO + Job snapshot data, uploads it under
// the deterministic key po/{id}.pdf (overwriting any prior preview), stores
// the blob name on the PO row, and returns a short-lived SAS URL that the
// frontend can hand to an <iframe> for inline preview. Re-calling regenerates.

async function previewPurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  let connection;
  try {
    const body = (await request.json()) as any;
    const { PurchaseOrderID } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createRequestConnection(token);

    // Fetch PO + Job snapshot + contractor email in one round-trip
    const rows = await executeQuery(
      connection,
      `SELECT
         po.PurchaseOrderID, po.JobID, po.PONumber, po.Seq, po.ContractorID,
         po.ContractorName, po.Scope, po.EstimatedCost, po.CostNotToExceed,
         po.CostJustification, po.EmailSubject, po.EmailBody, po.PDFBlobName,
         po.SentAt, po.SentBy, po.CreatedAt, po.CreatedBy, po.UpdatedAt,
         j.Title AS JobTitle, j.JobCode, j.LevelName, j.TenantName,
         j.Category, j.[Type] AS JobType, j.SubType, j.Priority,
         j.ExactLocation, j.ContactName, j.ContactPhone, j.ContactEmail,
         j.PersonAffected,
         b.BuildingName,
         c.EmailAddress AS ContractorEmail
       FROM PurchaseOrders po
       INNER JOIN Jobs j ON j.JobID = po.JobID
       LEFT JOIN Buildings b ON b.BuildingID = j.BuildingID
       LEFT JOIN Contractors c ON c.ContractorID = po.ContractorID
       WHERE po.PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    const r = rows[0];

    const pdfBuffer = await renderPurchaseOrderPDF({
      po: {
        poNumber: r.PONumber ?? null,
        contractorName: r.ContractorName ?? null,
        contractorEmail: r.ContractorEmail ?? null,
        scope: r.Scope ?? null,
        estimatedCost: r.EstimatedCost ?? null,
        costNotToExceed: r.CostNotToExceed ?? null,
        costJustification: r.CostJustification ?? null,
        createdBy: r.CreatedBy ?? null,
        createdAt: r.CreatedAt ?? null,
      },
      job: {
        jobCode: r.JobCode ?? null,
        title: r.JobTitle ?? null,
        buildingName: r.BuildingName ?? null,
        levelName: r.LevelName ?? null,
        exactLocation: r.ExactLocation ?? null,
        category: r.Category ?? null,
        type: r.JobType ?? null,
        subType: r.SubType ?? null,
        priority: r.Priority ?? null,
        contactName: r.ContactName ?? null,
        contactPhone: r.ContactPhone ?? null,
        contactEmail: r.ContactEmail ?? null,
        personAffected: r.PersonAffected ?? null,
      },
    });

    const { blobName } = await uploadPurchaseOrderPdf(PurchaseOrderID, pdfBuffer);

    // Populate default email subject + body on first preview so the UI can
    // show something sensible. User edits via upsertPurchaseOrder win
    // (COALESCE keeps whatever's already stored).
    const defaults = defaultPOEmail({
      po: {
        poNumber: r.PONumber ?? null,
        contractorName: r.ContractorName ?? null,
        scope: r.Scope ?? null,
        estimatedCost: r.EstimatedCost ?? null,
        costNotToExceed: r.CostNotToExceed ?? null,
        costJustification: r.CostJustification ?? null,
        createdBy: r.CreatedBy ?? null,
      },
      job: {
        jobCode: r.JobCode ?? null,
        title: r.JobTitle ?? null,
        buildingName: r.BuildingName ?? null,
        levelName: r.LevelName ?? null,
        exactLocation: r.ExactLocation ?? null,
        category: r.Category ?? null,
        type: r.JobType ?? null,
        subType: r.SubType ?? null,
        contactName: r.ContactName ?? null,
        contactPhone: r.ContactPhone ?? null,
        contactEmail: r.ContactEmail ?? null,
      },
    });

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
         SET PDFBlobName = @BlobName,
             EmailSubject = COALESCE(EmailSubject, @DefaultSubject),
             EmailBody    = COALESCE(EmailBody, @DefaultBody),
             UpdatedAt    = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
        { name: "BlobName", type: TYPES.NVarChar, value: blobName },
        { name: "DefaultSubject", type: TYPES.NVarChar, value: defaults.subject },
        { name: "DefaultBody", type: TYPES.NVarChar, value: defaults.body },
      ],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );

    const recipient = resolveRecipient(r.ContractorEmail ?? null);
    const url = generateReadSasUrl(blobName, 60 * 60 * 1000); // 1 hour
    return {
      status: 200,
      jsonBody: {
        purchaseOrder: stored[0],
        url,
        recipient: recipient.address,
        recipientOriginal: recipient.original,
        recipientOverridden: recipient.overridden,
      },
    };
  } catch (error: any) {
    context.error("previewPurchaseOrder failed:", error.message);
    return errorResponse("Preview purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/sendPurchaseOrder ──────────────────────────────────────────────
// Body: { PurchaseOrderID } — the sender (SentBy, and the CC copy) is the
// verified caller, never the body.
// Requires PDFBlobName to be set — caller must hit previewPurchaseOrder first.
// Flips SentAt/SentBy. Actual Microsoft Graph sendMail call is follow-on work
// — resolveRecipient + the generated PDF are ready for that wiring.
//
// Sending is a decision and an external send (PLAN §3.12). The mail can't be
// recalled, so the ledger actor and job scope are found before it goes; then
// SentAt/SentBy and the ledger row commit together or not at all.

interface SendPurchaseOrderBody {
  PurchaseOrderID?: number;
  /** @deprecated ignored — identity comes from the token */
  SentBy?: string;
  /** @deprecated ignored — the CC address is the token's email */
  SentByEmail?: string;
}

async function sendPurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, {
      attempted: "po.send",
      idField: "PurchaseOrderID",
      subjectType: "purchase_order",
    });
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as SendPurchaseOrderBody;
    const { PurchaseOrderID } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    const contractorRows = await executeQuery(
      connection,
      `SELECT c.EmailAddress, po.PDFBlobName, po.PONumber,
              po.EmailSubject, po.EmailBody,
              po.JobID, po.ContractorID, po.ContractorName,
              po.EstimatedCost, po.CostNotToExceed, po.SentAt
         FROM PurchaseOrders po
         LEFT JOIN Contractors c ON c.ContractorID = po.ContractorID
        WHERE po.PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (contractorRows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    if (!contractorRows[0]?.PDFBlobName) {
      return {
        status: 400,
        jsonBody: { error: "Preview the PO (generate a PDF) before sending." },
      };
    }
    const recipient = resolveRecipient(contractorRows[0]?.EmailAddress);
    if (!recipient.address) {
      return { status: 400, jsonBody: { error: "Contractor has no email address." } };
    }
    const pdfBlobName = contractorRows[0].PDFBlobName as string;
    const poNumber = contractorRows[0].PONumber as string | null;
    const emailSubject = (contractorRows[0].EmailSubject as string | null) ?? poNumber ?? "Purchase Order";
    const emailBody = (contractorRows[0].EmailBody as string | null) ?? "";
    const scope = await jobScope(connection, contractorRows[0].JobID as number | null | undefined);
    const previousSentAt = contractorRows[0].SentAt as Date | null | undefined;

    context.log(
      `[sendPurchaseOrder] PO#${PurchaseOrderID} → ${recipient.address}${
        recipient.overridden ? ` (overridden from ${recipient.original ?? "(none)"})` : ""
      } · pdf=${pdfBlobName}`,
    );

    const pdfBuffer = await downloadBlob(pdfBlobName);
    // A body-supplied CC would let any caller have the company mailbox copy an
    // arbitrary outside address.
    const ccAddresses = [identity.email];
    await graphSendMail(
      recipient.address,
      emailSubject,
      emailBody,
      [
        {
          fileName: `${poNumber ?? `PO-${PurchaseOrderID}`}.pdf`,
          contentType: "application/pdf",
          contentBase64: pdfBuffer.toString("base64"),
        },
      ],
      ccAddresses,
    );

    await beginTransaction(connection);
    try {
      await executeQuery(
        connection,
        `UPDATE PurchaseOrders
         SET SentAt = SYSUTCDATETIME(), SentBy = @SentBy, UpdatedAt = SYSUTCDATETIME()
         WHERE PurchaseOrderID = @Id`,
        [
          { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
          { name: "SentBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );
      await record(connection, {
        action: "po.send",
        actor,
        after: { sent: true, ...purchaseOrderFacts(contractorRows[0]) },
        // A re-send shows the earlier send here.
        before: { sentAt: previousSentAt ? new Date(previousSentAt).toISOString() : null, ...contractorFacts(contractorRows[0]) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: PurchaseOrderID, type: "purchase_order" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    return {
      status: 200,
      jsonBody: {
        purchaseOrder: stored[0],
        recipient: recipient.address,
        recipientOverridden: recipient.overridden,
      },
    };
  } catch (error: any) {
    context.error("sendPurchaseOrder failed:", error.message);
    return errorResponse("Send purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// What the ledger needs to know about a purchase order that is about to change or go.
const PO_LEDGER_COLUMNS = `JobID, PONumber, ContractorID, ContractorName, EstimatedCost, CostNotToExceed,
  PDFBlobName, SentAt, SentBy, MyobCreatedAt, MyobCreatedBy, CompletedAt, CompletedBy`;

// ── POST /api/deletePurchaseOrder ────────────────────────────────────────────
// Body: { PurchaseOrderID }
// Refuses to delete if SentAt is set — a sent PO is a real-world obligation
// and should not vanish silently. Best-effort blob cleanup on success.
//
// A deletion leaves nothing behind but its ledger row, so the row carries a
// snapshot of what was deleted, and the two commit together or not at all. The
// PDF goes only after that commit: had the ledger write failed, the PO would
// still be there and must keep its file.

const DELETE_PO_TARGET: RefusalTarget = {
  attempted: "po.delete",
  idField: "PurchaseOrderID",
  subjectType: "purchase_order",
};

async function deletePurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, DELETE_PO_TARGET);
    return denied;
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { PurchaseOrderID } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    let pdfBlobName: string | null;
    await beginTransaction(connection);
    try {
      // Locked until commit, so the snapshot is of the PO that is deleted.
      const rows = await executeQuery(
        connection,
        `SELECT ${PO_LEDGER_COLUMNS} FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PurchaseOrderID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Purchase order not found" } };
      }
      const po = rows[0];
      if (po.SentAt || po.CompletedAt) {
        // A refused attempt, ledgered in a transaction of its own now that this
        // one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const sent = Boolean(po.SentAt);
        const error = sent
          ? "Cannot delete a purchase order that has been sent."
          : "Cannot delete a purchase order that has been marked complete.";
        await recordRefusal(
          connection,
          actor,
          { id: PurchaseOrderID, type: "purchase_order" },
          { attempted: "po.delete", code: sent ? "po_sent" : "po_completed", message: error },
          po.JobID as number,
        );
        return { status: 400, jsonBody: { error } };
      }

      await executeQuery(
        connection,
        `DELETE FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
      );

      const scope = await jobScope(connection, po.JobID as number);
      const approvedQuote = await approvedQuoteAmount(connection, po.JobID as number);
      await record(connection, {
        action: "po.delete",
        actor,
        after: deletionAfter(purchaseOrderFacts(po), approvedQuote),
        before: purchaseOrderSnapshot(po),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: PurchaseOrderID, type: "purchase_order" },
      });
      await commitTransaction(connection);
      pdfBlobName = po.PDFBlobName as string | null;
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    if (pdfBlobName) {
      // Best-effort — if blob cleanup fails we don't want to resurrect the row.
      deleteBlob(pdfBlobName).catch((err) =>
        context.warn(`deletePurchaseOrder: blob cleanup failed for ${pdfBlobName}: ${err?.message}`),
      );
    }

    return { status: 200, jsonBody: { deleted: true, purchaseOrderId: PurchaseOrderID } };
  } catch (error: any) {
    context.error("deletePurchaseOrder failed:", error.message);
    return errorResponse("Delete purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/markPurchaseOrderMyobCreated ───────────────────────────────────
// Body: { id, jobId } — the actor is the verified caller, never the body.
// Records that this PO has been entered into MYOB. Cannot be undone once
// CompletedAt is set. The marking and its ledger row commit together or not at
// all. Floorplan makes no MYOB call here: someone has entered the PO in MYOB by
// hand and this stamps that it was done.

interface MarkPurchaseOrderMyobCreatedBody {
  id?: number;
  jobId?: number;
  /** @deprecated ignored — identity comes from the token */
  createdBy?: string;
}

const MARK_PO_MYOB_TARGET: RefusalTarget = {
  attempted: "po.myob_created",
  idField: "id",
  subjectType: "purchase_order",
};

async function markPurchaseOrderMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, MARK_PO_MYOB_TARGET);
    return denied;
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as MarkPurchaseOrderMyobCreatedBody;
    const { id, jobId } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the marking recorded as replaced is the one replaced.
      const rows = await executeQuery(
        connection,
        `SELECT ${PO_LEDGER_COLUMNS} FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Purchase order not found" } };
      }
      const po = rows[0];
      const poLabel = po.PONumber ?? `PO #${id}`;

      await executeQuery(
        connection,
        `UPDATE PurchaseOrders
           SET MyobCreatedAt = SYSUTCDATETIME(), MyobCreatedBy = @CreatedBy, UpdatedAt = SYSUTCDATETIME()
         WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
         VALUES (@JobID, @CreatedBy, @Text, 'po_myob_created', @PurchaseOrderID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Marked ${poLabel} as created in MYOB` },
          { name: "PurchaseOrderID", type: TYPES.Int, value: id },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      await record(connection, {
        action: "po.myob_created",
        actor,
        after: { myobCreated: true, ...purchaseOrderFacts(po) },
        // Marking again just re-stamps; the earlier marking shows here.
        before: { myobCreated: po.MyobCreatedAt != null, ...contractorFacts(po) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id, type: "purchase_order" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("markPurchaseOrderMyobCreated failed:", error.message);
    return errorResponse("Mark MYOB created failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unmarkPurchaseOrderMyobCreated ─────────────────────────────────
// Body: { id, jobId }
// Clears the MyobCreatedAt/By fields. Refused if CompletedAt is already set —
// cannot undo MYOB entry after the PO has been completed. The unmarking and its
// ledger row commit together or not at all; the row keeps who marked the PO and
// when, because unmarking clears those.

const UNMARK_PO_MYOB_TARGET: RefusalTarget = {
  attempted: "po.unmark_myob_created",
  idField: "id",
  subjectType: "purchase_order",
};

async function unmarkPurchaseOrderMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, UNMARK_PO_MYOB_TARGET);
    return denied;
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = (await request.json()) as any;
    const { id, jobId } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the marking recorded as cleared is the one cleared.
      const rows = await executeQuery(
        connection,
        `SELECT ${PO_LEDGER_COLUMNS} FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Purchase order not found" } };
      }
      const po = rows[0];
      if (po.CompletedAt) {
        // A refused attempt, ledgered in a transaction of its own now that this
        // one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = "Cannot undo MYOB entry — this purchase order has already been marked complete.";
        await recordRefusal(
          connection,
          actor,
          { id, type: "purchase_order" },
          { attempted: "po.unmark_myob_created", code: "po_completed", message: error },
          po.JobID as number,
        );
        return { status: 400, jsonBody: { error } };
      }
      const poLabel = po.PONumber ?? `PO #${id}`;

      await executeQuery(
        connection,
        `UPDATE PurchaseOrders
           SET MyobCreatedAt = NULL, MyobCreatedBy = NULL, UpdatedAt = SYSUTCDATETIME()
         WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
         VALUES (@JobID, NULL, @Text, 'po_myob_uncreated', @PurchaseOrderID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "Text", type: TYPES.NVarChar, value: `Unmarked ${poLabel} from MYOB created` },
          { name: "PurchaseOrderID", type: TYPES.Int, value: id },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      const approvedQuote = await approvedQuoteAmount(connection, jobId);
      await record(connection, {
        action: "po.unmark_myob_created",
        actor,
        after: { myobCreated: false, ...purchaseOrderFacts(po), ...amountUnchanged(po.EstimatedCost, approvedQuote) },
        before: purchaseOrderSnapshot(po),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id, type: "purchase_order" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("unmarkPurchaseOrderMyobCreated failed:", error.message);
    return errorResponse("Unmark MYOB created failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/markPurchaseOrderComplete ──────────────────────────────────────
// Body: { id, jobId } — the actor is the verified caller, never the body.
// Requires MyobCreatedAt to be set first. Transitions the job to
// status='Awaiting Approval', awaitingRole='accounts'. The completion, the job
// move and the ledger row commit together or not at all.

interface MarkPurchaseOrderCompleteBody {
  id?: number;
  jobId?: number;
  /** @deprecated ignored — identity comes from the token */
  completedBy?: string;
}

const COMPLETE_PO_TARGET: RefusalTarget = {
  attempted: "po.complete",
  idField: "id",
  subjectType: "purchase_order",
};

async function markPurchaseOrderComplete(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, COMPLETE_PO_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as MarkPurchaseOrderCompleteBody;
    const { id, jobId } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the MYOB marking we check is the one we act on.
      const rows = await executeQuery(
        connection,
        `SELECT ${PO_LEDGER_COLUMNS} FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Purchase order not found" } };
      }
      const po = rows[0];
      if (!po.MyobCreatedAt) {
        // Completing a PO the books don't have yet is a refused attempt,
        // ledgered in a transaction of its own now that this one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = "Cannot mark complete — this purchase order has not been marked as created in MYOB yet.";
        await recordRefusal(
          connection,
          actor,
          { id, type: "purchase_order" },
          { attempted: "po.complete", code: "not_created_in_myob", message: error },
          po.JobID as number,
        );
        return { status: 400, jsonBody: { error } };
      }
      const poLabel = po.PONumber ?? `PO #${id}`;

      await executeQuery(
        connection,
        `UPDATE PurchaseOrders
           SET CompletedAt = SYSUTCDATETIME(), CompletedBy = @CompletedBy, UpdatedAt = SYSUTCDATETIME()
         WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CompletedBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );

      // Fire PO-completion event (kept separate from the status_change row).
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
         VALUES (@JobID, @CreatedBy, @Text, 'po_completed', @PurchaseOrderID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Marked ${poLabel} complete` },
          { name: "PurchaseOrderID", type: TYPES.Int, value: id },
        ],
      );

      // Advance the job through the state machine. From (Work, facilities) this
      // lands at (Awaiting Approval, accounts). The previous inline UPDATE
      // unconditionally clobbered Status to 'Awaiting Approval' regardless of
      // the prior state — that's the silent-demotion bug. The helper refuses
      // backward moves, so completing a PO can no longer undo a manual status.
      await advanceJobStatus(connection, jobId, JobEvent.WORK_COMPLETED, {
        actor: identity.name,
        purchaseOrderId: id,
        note: `${poLabel} complete — awaiting accounts approval.`,
      });

      const scope = await jobScope(connection, jobId);
      await record(connection, {
        action: "po.complete",
        actor,
        after: { completed: true, ...purchaseOrderFacts(po) },
        // Completing again just re-stamps; the earlier completion shows here.
        before: { completed: po.CompletedAt != null, ...contractorFacts(po) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id, type: "purchase_order" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("markPurchaseOrderComplete failed:", error.message);
    return errorResponse("Mark complete failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unmarkPurchaseOrderComplete ────────────────────────────────────
// Body: { id, jobId }
// Clears CompletedAt/By and rolls the job back to status='Work', awaitingRole='facilities'.
// The reversal, the job move and the ledger row commit together or not at all;
// the row keeps who completed the PO and when, because the reversal clears those.

const UNCOMPLETE_PO_TARGET: RefusalTarget = {
  attempted: "po.uncomplete",
  idField: "id",
  subjectType: "purchase_order",
};

async function unmarkPurchaseOrderComplete(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, UNCOMPLETE_PO_TARGET);
    return denied;
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { id, jobId } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the completion recorded as cleared is the one cleared.
      const rows = await executeQuery(
        connection,
        `SELECT ${PO_LEDGER_COLUMNS} FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Purchase order not found" } };
      }
      const po = rows[0];
      const poLabel = po.PONumber ?? `PO #${id}`;

      await executeQuery(
        connection,
        `UPDATE PurchaseOrders
           SET CompletedAt = NULL, CompletedBy = NULL, UpdatedAt = SYSUTCDATETIME()
         WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );

      // N3 (J2): undoing a completion never moves the job. Done stays done
      // (reopening is a manager's job, with a reason: reopenJob); a job
      // already with accounts stays there.
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
         VALUES (@JobID, @CreatedBy, @Text, 'po_uncompleted', @PurchaseOrderID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: actor.name },
          { name: "Text", type: TYPES.NVarChar, value: `Unmarked ${poLabel} as complete` },
          { name: "PurchaseOrderID", type: TYPES.Int, value: id },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      const approvedQuote = await approvedQuoteAmount(connection, jobId);
      await record(connection, {
        action: "po.uncomplete",
        actor,
        after: { completed: false, ...purchaseOrderFacts(po), ...amountUnchanged(po.EstimatedCost, approvedQuote) },
        before: purchaseOrderSnapshot(po),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id, type: "purchase_order" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("unmarkPurchaseOrderComplete failed:", error.message);
    return errorResponse("Unmark complete failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getPurchaseOrders", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getPurchaseOrders,
});
app.http("upsertPurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertPurchaseOrder,
});
app.http("sendPurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: sendPurchaseOrder,
});
app.http("previewPurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: previewPurchaseOrder,
});
app.http("deletePurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deletePurchaseOrder,
});
app.http("markPurchaseOrderMyobCreated", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: markPurchaseOrderMyobCreated,
});
app.http("unmarkPurchaseOrderMyobCreated", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: unmarkPurchaseOrderMyobCreated,
});
app.http("markPurchaseOrderComplete", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: markPurchaseOrderComplete,
});
app.http("unmarkPurchaseOrderComplete", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: unmarkPurchaseOrderComplete,
});
