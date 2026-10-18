import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

// ── POST /api/setTestFlag ────────────────────────────────────────────────────
// Body { Kind, Id, IsTest, Reason }. Admin only (the frontend asks them to
// confirm). A test record never leaves Floorplan and stays out of lists unless
// an admin shows test data (D9); this is the one way to change that after
// create. The flag and its ledger row (test_data.flag, with the reason) commit
// together. Quotes, invoices, purchase orders and payments follow their job.
//
// Decision 4 lets an admin approve, pay or mark money only on a test job, so
// a job's flag is frozen once money has moved on it: real -> test is refused
// when the job or any of its money records has been approved, paid,
// MYOB-marked or proposed, a director email has gone, or a PO has been sent;
// test -> real is refused on the same evidence, because any such decision on a
// test job was taken while it was test (it could only have become test with
// none). Both are read under the job's lock.

type FlagKind = "inspection" | "job" | "key" | "tenancy" | "vacancy";

export const SET_TEST_FLAG_SQL: Record<FlagKind, { read: string; update: string }> = {
  inspection: {
    read: `SELECT IsTest, BuildingId FROM dbo.Inspections WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id`,
    update: `UPDATE dbo.Inspections SET IsTest = @IsTest WHERE Id = @Id`,
  },
  job: {
    read: `SELECT j.IsTest, j.BuildingID AS BuildingId, j.ApprovedQuoteID,
       (SELECT COUNT(*) FROM dbo.Quotes q WHERE q.JobID = j.JobID AND (q.Status IN (N'approved', N'awaiting_director', N'completed') OR q.DirectorEmailSentAt IS NOT NULL)) AS QuoteDecisions,
       (SELECT COUNT(*) FROM dbo.JobInvoices i WHERE i.JobID = j.JobID AND (i.Status IN (N'approved', N'director_approved', N'awaiting_approval') OR i.MyobCreatedAt IS NOT NULL OR i.DirectorEmailSentAt IS NOT NULL)) AS InvoiceDecisions,
       (SELECT COUNT(*) FROM dbo.PurchaseOrders po WHERE po.JobID = j.JobID AND (po.SentAt IS NOT NULL OR po.MyobCreatedAt IS NOT NULL OR po.CompletedAt IS NOT NULL)) AS PoDecisions,
       (SELECT COUNT(*) FROM dbo.Payments p WHERE p.JobID = j.JobID) AS Payments
  FROM dbo.Jobs j WITH (UPDLOCK, HOLDLOCK) WHERE j.JobID = @Id`,
    update: `UPDATE dbo.Jobs SET IsTest = @IsTest WHERE JobID = @Id`,
  },
  key: {
    read: `SELECT IsTest, BuildingId FROM dbo.Keys WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id`,
    update: `UPDATE dbo.Keys SET IsTest = @IsTest WHERE Id = @Id`,
  },
  tenancy: {
    read: `SELECT IsTest, BuildingId FROM dbo.Tenants WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @Id`,
    update: `UPDATE dbo.Tenants SET IsTest = @IsTest WHERE TenantId = @Id`,
  },
  vacancy: {
    read: `SELECT IsTest, BuildingId FROM dbo.Vacancies WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id`,
    update: `UPDATE dbo.Vacancies SET IsTest = @IsTest WHERE Id = @Id`,
  },
};

// MyobProposals (migration 126) is read only where it exists.
export const JOB_PROPOSALS_SQL = `DECLARE @Proposals INT = 0;
IF OBJECT_ID(N'dbo.MyobProposals', N'U') IS NOT NULL
  SELECT @Proposals = COUNT(*) FROM dbo.MyobProposals WHERE JobId = @Id;
SELECT @Proposals AS Proposals;`;

/** The money decisions on a job, in words; empty when there are none. */
function moneyDecisions(row: Record<string, unknown>, proposals: number): string[] {
  const num = (value: unknown) => Number(value ?? 0);
  return [
    ...(row.ApprovedQuoteID !== null && row.ApprovedQuoteID !== undefined ? ["an approved quote"] : []),
    ...(num(row.QuoteDecisions) > 0 ? ["a quote decision"] : []),
    ...(num(row.InvoiceDecisions) > 0 ? ["an invoice decision"] : []),
    ...(num(row.PoDecisions) > 0 ? ["a purchase order sent, completed or marked in MYOB"] : []),
    ...(num(row.Payments) > 0 ? ["a payment"] : []),
    ...(proposals > 0 ? ["a MYOB proposal"] : []),
  ];
}

const isKind = (value: unknown): value is FlagKind =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(SET_TEST_FLAG_SQL, value);

export async function setTestFlag(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.ADMIN]);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { Id?: unknown; IsTest?: unknown; Kind?: unknown; Reason?: unknown } | null;
  const kind = body?.Kind;
  const id = body?.Id;
  const isTest = body?.IsTest;
  const reason = typeof body?.Reason === "string" ? body.Reason.trim() : "";
  if (!isKind(kind)) return { status: 400, jsonBody: { error: "Kind must be job, tenancy, inspection, key or vacancy" } };
  if (typeof id !== "number" || !Number.isInteger(id)) return { status: 400, jsonBody: { error: "Id (number) required" } };
  if (typeof isTest !== "boolean") return { status: 400, jsonBody: { error: "IsTest (true or false) required" } };
  if (!reason) return { status: 400, jsonBody: { error: "A reason is required" } };
  if (reason.length > 2000) return { status: 400, jsonBody: { error: "Reason must be 2000 characters or fewer" } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const idParam = { name: "Id", type: TYPES.Int, value: id };

    let buildingId: number | null;
    await beginTransaction(connection);
    try {
      const [row] = await executeQuery(connection, SET_TEST_FLAG_SQL[kind].read, [idParam]);
      if (!row) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Record not found" } };
      }
      const was = row.IsTest === true || row.IsTest === 1;
      if (was === isTest) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { error: isTest ? "Already a test record" : "Already a real record" } };
      }
      if (kind === "job") {
        const [proposalRow] = await executeQuery(connection, JOB_PROPOSALS_SQL, [idParam]);
        const decided = moneyDecisions(row, Number(proposalRow?.Proposals ?? 0));
        if (decided.length > 0) {
          await rollbackTransaction(connection).catch(() => {});
          const what = decided.join(", ");
          return {
            status: 409,
            jsonBody: {
              error: isTest
                ? `Job #${id} already has ${what}, so it can't become test data.`
                : `Job #${id} had ${what} while it was test data, so it can't become real data.`,
            },
          };
        }
      }
      buildingId = (row.BuildingId as number | null) ?? null;
      await executeQuery(connection, SET_TEST_FLAG_SQL[kind].update, [idParam, { name: "IsTest", type: TYPES.Bit, value: isTest }]);
      await record(connection, {
        action: "test_data.flag",
        actor,
        after: { isTest },
        before: { isTest: was },
        buildingId,
        reason,
        ...(kind === "job" ? { jobId: id } : {}),
        ...(kind === "tenancy" ? { tenantId: id } : {}),
        subject: { id, type: kind },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    if (kind === "tenancy" && buildingId !== null) invalidateTenantAndBuilding(id, buildingId);
    return { status: 200, jsonBody: { id, isTest, kind } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("setTestFlag failed:", message);
    return errorResponse("Changing the test flag failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setTestFlag", { authLevel: "anonymous", handler: setTestFlag, methods: ["POST"] });
