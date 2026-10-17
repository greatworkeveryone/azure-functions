import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

// ── POST /api/setTestFlag ────────────────────────────────────────────────────
// Body { Kind, Id, IsTest }. Admin only (the frontend asks them to confirm).
// A test record never leaves Floorplan and stays out of lists unless an admin
// shows test data (D9); this is the one way to change that after create. The
// flag and its ledger row (test_data.flag) commit together. Quotes, invoices,
// purchase orders and payments follow their job.

type FlagKind = "inspection" | "job" | "key" | "tenancy" | "vacancy";

export const SET_TEST_FLAG_SQL: Record<FlagKind, { read: string; update: string }> = {
  inspection: {
    read: `SELECT IsTest, BuildingId FROM dbo.Inspections WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id`,
    update: `UPDATE dbo.Inspections SET IsTest = @IsTest WHERE Id = @Id`,
  },
  job: {
    read: `SELECT IsTest, BuildingID AS BuildingId FROM dbo.Jobs WITH (UPDLOCK, HOLDLOCK) WHERE JobID = @Id`,
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

const isKind = (value: unknown): value is FlagKind =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(SET_TEST_FLAG_SQL, value);

export async function setTestFlag(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.ADMIN]);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { Id?: unknown; IsTest?: unknown; Kind?: unknown } | null;
  const kind = body?.Kind;
  const id = body?.Id;
  const isTest = body?.IsTest;
  if (!isKind(kind)) return { status: 400, jsonBody: { error: "Kind must be job, tenancy, inspection, key or vacancy" } };
  if (typeof id !== "number" || !Number.isInteger(id)) return { status: 400, jsonBody: { error: "Id (number) required" } };
  if (typeof isTest !== "boolean") return { status: 400, jsonBody: { error: "IsTest (true or false) required" } };

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
      buildingId = (row.BuildingId as number | null) ?? null;
      await executeQuery(connection, SET_TEST_FLAG_SQL[kind].update, [idParam, { name: "IsTest", type: TYPES.Bit, value: isTest }]);
      await record(connection, {
        action: "test_data.flag",
        actor,
        after: { isTest },
        before: { isTest: was },
        buildingId,
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
