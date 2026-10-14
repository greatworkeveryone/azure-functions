import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "./auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "./db";
import { record } from "./ledger";
import { resolveLedgerActor } from "./ledger/actor";
import { invalidateTenant } from "./tenant-register-cache";

// Tenancies and their lease documents are archived, never hard-deleted (D4:
// DL-04, DL-19; database-safety rule 1). Archive is reversible, stamped
// (ArchivedAt/By, migrations 129 and 135) and ledgered. The one hard delete
// left is an empty draft: no rent schedule, no areas, no documents and no
// jobs. (A schedule sign-off can't exist without schedule rows, so "no
// schedule" covers it.)

export interface TenancyFacts {
  archivedAt: Date | null;
  buildingId: number | null;
  documents: number;
  jobs: number;
  legalName: string;
  occupancies: number;
  scheduleRows: number;
}

// Locked until the caller's transaction ends, so what is checked is what is
// archived or deleted.
const TENANCY_FACTS_SQL = `SELECT t.LegalName, t.BuildingId, t.ArchivedAt, t.ScheduledRateSteps,
       (SELECT COUNT(*) FROM dbo.Jobs j WHERE j.TenantID = t.TenantId) AS Jobs,
       (SELECT COUNT(*) FROM dbo.TenantOccupancies o WHERE o.TenantId = t.TenantId) AS Occupancies,
       (SELECT COUNT(*) FROM dbo.TenancyAttachments ta WHERE ta.TenantId = t.TenantId) AS Documents
  FROM dbo.Tenants t WITH (UPDLOCK, HOLDLOCK)
 WHERE t.TenantId = @Id`;

function countSteps(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export async function readTenancyFacts(connection: Connection, tenantId: number): Promise<TenancyFacts | null> {
  const [row] = await executeQuery(connection, TENANCY_FACTS_SQL, [{ name: "Id", type: TYPES.Int, value: tenantId }]);
  if (!row) return null;
  return {
    archivedAt: (row.ArchivedAt as Date | null) ?? null,
    buildingId: (row.BuildingId as number | null) ?? null,
    documents: Number(row.Documents ?? 0),
    jobs: Number(row.Jobs ?? 0),
    legalName: String(row.LegalName ?? `Tenancy #${tenantId}`),
    occupancies: Number(row.Occupancies ?? 0),
    scheduleRows: countSteps(row.ScheduledRateSteps),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export const JOBS_REFUSAL = "Cannot delete — tenant is assigned to at least one job. Reassign first.";

/** Why this tenancy can't be hard-deleted (it isn't an empty draft), or null. */
export function deletionRefusal(facts: TenancyFacts): { error: string; status: number } | null {
  if (facts.jobs > 0) return { error: JOBS_REFUSAL, status: 400 };
  const has = [
    ...(facts.scheduleRows > 0 ? ["a rent schedule"] : []),
    ...(facts.occupancies > 0 ? [plural(facts.occupancies, "area")] : []),
    ...(facts.documents > 0 ? [plural(facts.documents, "document")] : []),
  ];
  if (has.length === 0) return null;
  return { error: `${facts.legalName} has ${listOf(has)}, so it can't be deleted. Archive it instead.`, status: 422 };
}

/** The tenancy whose lease document this file is, if any. */
export async function tenancyOfDocument(connection: Connection, attachmentId: number): Promise<string | null> {
  const [row] = await executeQuery(
    connection,
    `SELECT TOP 1 t.LegalName
       FROM dbo.TenancyAttachments ta
       JOIN dbo.Tenants t ON t.TenantId = ta.TenantId
      WHERE ta.AttachmentID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: attachmentId }],
  );
  return row ? String(row.LegalName) : null;
}

export const leaseDocumentRefusal = (legalName: string) =>
  `This file is a lease document of ${legalName}, so it can't be deleted. Archive it instead.`;

const ARCHIVE_SQL = `UPDATE dbo.Tenants SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By
 WHERE TenantId = @Id AND ArchivedAt IS NULL`;
const UNARCHIVE_SQL = `UPDATE dbo.Tenants SET ArchivedAt = NULL, ArchivedBy = NULL
 WHERE TenantId = @Id AND ArchivedAt IS NOT NULL`;

/**
 * POST archiveTenant / unarchiveTenant. Body { TenantId, Reason }. Roles:
 * accounts_manager and above (cfo, director, admin through requireRole's
 * hierarchy; the frontend's archiveTenancy capability mirrors this). The
 * stamp and its ledger row commit together.
 */
export async function setTenancyArchived(
  request: HttpRequest,
  context: InvocationContext,
  archive: boolean,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { Reason?: unknown; TenantId?: unknown } | null;
  const tenantId = body?.TenantId;
  const reason = typeof body?.Reason === "string" ? body.Reason.trim() : "";
  if (typeof tenantId !== "number" || !Number.isInteger(tenantId)) {
    return { status: 400, jsonBody: { error: "TenantId (number) required" } };
  }
  if (!reason) return { status: 400, jsonBody: { error: "A reason is required" } };
  if (reason.length > 2000) return { status: 400, jsonBody: { error: "Reason must be 2000 characters or fewer" } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      const facts = await readTenancyFacts(connection, tenantId);
      if (!facts) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Tenancy not found" } };
      }
      if ((facts.archivedAt !== null) === archive) {
        await rollbackTransaction(connection).catch(() => {});
        const state = archive ? "already archived" : "not archived";
        return { status: 409, jsonBody: { error: `${facts.legalName} is ${state}.` } };
      }
      await executeQuery(connection, archive ? ARCHIVE_SQL : UNARCHIVE_SQL, [
        { name: "Id", type: TYPES.Int, value: tenantId },
        { name: "By", type: TYPES.NVarChar, value: actor.name },
      ]);
      await record(connection, {
        action: archive ? "tenancy.archive" : "tenancy.unarchive",
        actor,
        buildingId: facts.buildingId,
        reason,
        subject: { id: tenantId, type: "tenancy" },
        tenantId,
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    invalidateTenant(tenantId);
    return { status: 200, jsonBody: { archived: archive, tenantId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${archive ? "archiveTenant" : "unarchiveTenant"} failed:`, message);
    return errorResponse(archive ? "Archive tenancy failed" : "Restore tenancy failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}
