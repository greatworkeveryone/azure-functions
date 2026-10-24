import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { callerFromToken } from "../callerFromToken";
import { closeConnection, createRequestConnection } from "../db";
import { parseBulkAdditions } from "../infoSheetBulk";
import { INFO_SHEET_RATE_LIMIT, INFO_SHEET_ROLES, infoSheetVersionOf, writeInfoSheet } from "../infoSheetWrite";
import { resolveLedgerActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

// POST /api/addInfoSheetRows (D11 re-check S2-3). A bulk add is one write: every
// row of every section goes in under one row lock, one version check and one
// transaction, and counts once against the info sheet's 60 writes a minute. A
// stale `InfoSheetVersion` is a 409 with nothing written, so a retry can't add rows
// twice; one section gone or one row id already there refuses the lot. Ledgered
// as tenancy.info_sheet_rows_added with only the rows added.
//
// Body: { TenantId, BuildingId, InfoSheetVersion, Additions: [{ IsNew, Rows, Section: { id, title?, displayOrder? } }] }.
export async function addInfoSheetRows(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [...INFO_SHEET_ROLES]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`infosheet:${caller.id}`, INFO_SHEET_RATE_LIMIT);
  if (!rl.allowed) {
    return { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) }, jsonBody: { error: "Rate limit exceeded" } };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const tenantId = Number(body.TenantId);
    const buildingId = Number(body.BuildingId);
    if (!Number.isFinite(tenantId) || !Number.isFinite(buildingId)) {
      return { status: 400, jsonBody: { error: "TenantId and BuildingId required" } };
    }
    const version = infoSheetVersionOf(body);
    if (typeof version !== "number") return version;
    const parsed = parseBulkAdditions(body.Additions);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await writeInfoSheet(connection, {
      buildingId,
      caller,
      expectedVersion: version,
      ledger: { action: "tenancy.info_sheet_rows_added", actor },
      op: { additions: parsed.additions, kind: "addRows" },
      tenantId,
    });
    if (!outcome.ok) return outcome.response;
    invalidateTenantAndBuilding(tenantId, buildingId);
    return { status: 200, jsonBody: { infoSheetVersion: outcome.version, sections: outcome.sections } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("addInfoSheetRows failed:", message);
    return errorResponse("Failed to add info sheet rows", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("addInfoSheetRows", { authLevel: "anonymous", handler: addInfoSheetRows, methods: ["POST"] });
