import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { AppRole, errorResponse, unauthorizedResponse } from "./auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "./db";
import { record } from "./ledger";
import { resolveLedgerActor } from "./ledger/actor";
import { invalidateTenant } from "./tenant-register-cache";

// Tenancies and their lease documents are archived, never hard-deleted (D4:
// DL-04, DL-19; database-safety rule 1). Archive is reversible, stamped
// (ArchivedAt/By, migrations 129 and 135) and ledgered. The one hard delete
// left is an empty draft (deleteTenancyDraft below), reviewed in
// src/__tests__/db-safety-guards.test.ts.

export const TENANCY_ARCHIVE_ROLES = [AppRole.ACCOUNTS_APPROVAL] as const;
export const TENANCY_DELETE_ROLES = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR] as const;

interface TenancyState {
  archivedAt: Date | null;
  buildingId: number | null;
  legalName: string;
}

// Locked until the caller's transaction ends, so what is checked is what is archived.
const TENANCY_STATE_SQL = `SELECT t.LegalName, t.BuildingId, t.ArchivedAt
  FROM dbo.Tenants t WITH (UPDLOCK, HOLDLOCK)
 WHERE t.TenantId = @Id`;

async function readTenancyState(connection: Connection, tenantId: number): Promise<TenancyState | null> {
  const [row] = await executeQuery(connection, TENANCY_STATE_SQL, [{ name: "Id", type: TYPES.Int, value: tenantId }]);
  if (!row) return null;
  return {
    archivedAt: (row.ArchivedAt as Date | null) ?? null,
    buildingId: (row.BuildingId as number | null) ?? null,
    legalName: String(row.LegalName ?? `Tenancy #${tenantId}`),
  };
}

// ── The empty-draft rule ─────────────────────────────────────────────────────
// Removing a Tenants row cascades into its occupancies, notes, rent reviews,
// rent schedule change log (which revert restores from) and document links, and
// strands its decision-ledger rows. So it is allowed only for a tenancy that
// nothing refers to and nothing has been recorded against. Every table that
// refers to a tenancy is read here, each under a range lock (HOLDLOCK) inside the
// delete's transaction so no row can be added between this check and the delete.

export interface DraftFacts extends TenancyState {
  carparks: number;
  decisions: number;
  defectsPeriods: number;
  documents: number;
  jobs: number;
  keys: number;
  notes: number;
  occupancies: number;
  occupancyHistory: number;
  rentReviews: number;
  scheduleChanges: number;
  scheduleRows: number;
  signedOff: boolean;
  vacancies: number;
}

const DRAFT_FACTS_SQL = `SELECT t.LegalName, t.BuildingId, t.ArchivedAt, t.ScheduledRateSteps,
       (SELECT COUNT(*) FROM dbo.Jobs j WITH (HOLDLOCK) WHERE j.TenantID = t.TenantId) AS Jobs,
       (SELECT COUNT(*) FROM dbo.Keys k WITH (HOLDLOCK) WHERE k.TenancyId = t.TenantId) AS Keys,
       (SELECT COUNT(*) FROM dbo.Vacancies v WITH (HOLDLOCK) WHERE v.TenancyId = t.TenantId) AS Vacancies,
       (SELECT COUNT(*) FROM dbo.TenantOccupancies o WITH (HOLDLOCK) WHERE o.TenantId = t.TenantId) AS Occupancies,
       (SELECT COUNT(*) FROM dbo.TenantOccupancyHistory h WITH (HOLDLOCK) WHERE h.TenantId = t.TenantId) AS OccupancyHistory,
       (SELECT COUNT(*) FROM dbo.TenantNotes n WITH (HOLDLOCK) WHERE n.TenantId = t.TenantId) AS Notes,
       (SELECT COUNT(*) FROM dbo.RentReviews r WITH (HOLDLOCK) WHERE r.TenantId = t.TenantId) AS RentReviews,
       (SELECT COUNT(*) FROM dbo.RentScheduleChangeLog c WITH (HOLDLOCK) WHERE c.TenantId = t.TenantId) AS ScheduleChanges,
       (SELECT COUNT(*) FROM dbo.TenancyAttachments ta WITH (HOLDLOCK) WHERE ta.TenantId = t.TenantId) AS Documents,
       (SELECT COUNT(*) FROM dbo.Carparks cp WITH (HOLDLOCK) WHERE cp.TenantId = t.TenantId) AS Carparks,
       (SELECT COUNT(*) FROM dbo.DecisionLedger d WITH (HOLDLOCK) WHERE d.SubjectType = N'tenancy' AND d.SubjectId = @IdText)
     + (SELECT COUNT(*) FROM dbo.DecisionLedger d2 WITH (HOLDLOCK) WHERE d2.TenantId = t.TenantId) AS Decisions
  FROM dbo.Tenants t WITH (UPDLOCK, HOLDLOCK)
 WHERE t.TenantId = @Id`;

// Sign-off (migration 097) and defects periods (119) may not exist yet where
// this runs; each is read only when its column or table does.
const OPTIONAL_DRAFT_FACTS_SQL = `DECLARE @SignedOff INT = 0, @Defects INT = 0;
IF COL_LENGTH(N'dbo.Tenants', N'ScheduleSignedOffAt') IS NOT NULL
  EXEC sp_executesql
    N'SELECT @n = COUNT(*) FROM dbo.Tenants WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @Id AND ScheduleSignedOffAt IS NOT NULL',
    N'@Id INT, @n INT OUTPUT', @Id = @Id, @n = @SignedOff OUTPUT;
IF OBJECT_ID(N'dbo.DefectsPeriods', N'U') IS NOT NULL
  SELECT @Defects = COUNT(*) FROM dbo.DefectsPeriods WITH (HOLDLOCK) WHERE TenantId = @Id;
SELECT @SignedOff AS SignedOff, @Defects AS DefectsPeriods;`;

const DELETE_DRAFT_SQL = `DELETE FROM dbo.Tenants WHERE TenantId = @Id`;

// Schedule text that is not an empty list (or null) counts as a schedule, even
// when it can't be read: unreadable is never taken to mean empty.
function countSteps(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length;
    return parsed === null ? 0 : 1;
  } catch {
    return 1;
  }
}

export async function readDraftFacts(connection: Connection, tenantId: number): Promise<DraftFacts | null> {
  const [row] = await executeQuery(connection, DRAFT_FACTS_SQL, [
    { name: "Id", type: TYPES.Int, value: tenantId },
    { name: "IdText", type: TYPES.NVarChar, value: String(tenantId) },
  ]);
  if (!row) return null;
  const [optional] = await executeQuery(connection, OPTIONAL_DRAFT_FACTS_SQL, [{ name: "Id", type: TYPES.Int, value: tenantId }]);
  const num = (value: unknown) => Number(value ?? 0);
  return {
    archivedAt: (row.ArchivedAt as Date | null) ?? null,
    buildingId: (row.BuildingId as number | null) ?? null,
    carparks: num(row.Carparks),
    decisions: num(row.Decisions),
    defectsPeriods: num(optional?.DefectsPeriods),
    documents: num(row.Documents),
    jobs: num(row.Jobs),
    keys: num(row.Keys),
    legalName: String(row.LegalName ?? `Tenancy #${tenantId}`),
    notes: num(row.Notes),
    occupancies: num(row.Occupancies),
    occupancyHistory: num(row.OccupancyHistory),
    rentReviews: num(row.RentReviews),
    scheduleChanges: num(row.ScheduleChanges),
    scheduleRows: countSteps(row.ScheduledRateSteps),
    signedOff: num(optional?.SignedOff) > 0,
    vacancies: num(row.Vacancies),
  };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export const JOBS_REFUSAL = "Cannot delete — tenant is assigned to at least one job. Reassign first.";

/** Why this tenancy can't be hard-deleted (it isn't an empty draft), or null when it can. */
export function draftDeletionRefusal(facts: DraftFacts): { error: string; status: number } | null {
  if (facts.jobs > 0) return { error: JOBS_REFUSAL, status: 400 };
  const has = [
    ...(facts.scheduleRows > 0 ? ["a rent schedule"] : []),
    ...(facts.occupancies > 0 ? [counted(facts.occupancies, "area", "areas")] : []),
    ...(facts.occupancyHistory > 0 ? ["area history"] : []),
    ...(facts.notes > 0 ? [counted(facts.notes, "note", "notes")] : []),
    ...(facts.rentReviews > 0 ? [counted(facts.rentReviews, "rent review", "rent reviews")] : []),
    ...(facts.scheduleChanges > 0 ? ["rent schedule history"] : []),
    ...(facts.documents > 0 ? [counted(facts.documents, "document", "documents")] : []),
    ...(facts.keys > 0 ? [counted(facts.keys, "key", "keys")] : []),
    ...(facts.vacancies > 0 ? [counted(facts.vacancies, "vacancy", "vacancies")] : []),
    ...(facts.carparks > 0 ? [counted(facts.carparks, "car park", "car parks")] : []),
    ...(facts.defectsPeriods > 0 ? [counted(facts.defectsPeriods, "defects period", "defects periods")] : []),
    ...(facts.signedOff ? ["a schedule sign-off"] : []),
    ...(facts.decisions > 0 ? ["decision history"] : []),
  ];
  if (has.length === 0) return null;
  return { error: `${facts.legalName} has ${listOf(has)}, so it can't be deleted. Archive it instead.`, status: 422 };
}

/**
 * The only tenancy hard delete (deleteRegisterTenant and deleteTenant both call
 * it after their role check): an empty draft, checked under lock, removed and
 * ledgered as tenancy.delete_draft in one transaction. Anything else is refused
 * and pointed at archiveTenant.
 */
export async function deleteTenancyDraft(
  request: HttpRequest,
  context: InvocationContext,
  token: string,
  tenantId: number,
  route: string,
): Promise<HttpResponseInit> {
  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      const facts = await readDraftFacts(connection, tenantId);
      if (!facts) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Tenancy not found" } };
      }
      const refusal = draftDeletionRefusal(facts);
      if (refusal) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: refusal.status, jsonBody: { error: refusal.error } };
      }
      await executeQuery(connection, DELETE_DRAFT_SQL, [{ name: "Id", type: TYPES.Int, value: tenantId }]);
      await record(connection, {
        action: "tenancy.delete_draft",
        actor,
        before: { buildingId: facts.buildingId, legalName: facts.legalName },
        buildingId: facts.buildingId,
        subject: { id: tenantId, type: "tenancy" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    invalidateTenant(tenantId);
    return { status: 200, jsonBody: { deleted: true, tenantId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${route} failed:`, message);
    return errorResponse("Delete tenancy failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
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
 * POST archiveTenant / unarchiveTenant, after the route's role check
 * (TENANCY_ARCHIVE_ROLES: accounts_manager, and cfo, director and admin through
 * requireRole's hierarchy; the frontend's archiveTenancy capability mirrors
 * it). Body { TenantId, Reason }. The stamp and its ledger row commit together.
 */
export async function setTenancyArchived(
  request: HttpRequest,
  context: InvocationContext,
  token: string,
  archive: boolean,
): Promise<HttpResponseInit> {
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
      const facts = await readTenancyState(connection, tenantId);
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
