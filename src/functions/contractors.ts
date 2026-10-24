import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createRequestConnection, executeQuery, closeConnection, SqlParam } from "../db";
import { fetchAllContractors, createOrUpdateContractors, MyContractor } from "../mybuildings-client";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";

interface UpdateContractorsBody {
  Contractors?: unknown;
  contractors?: unknown;
}

// Only these reach myBuildings; anything else in the body is dropped.
const CONTRACTOR_STRING_FIELDS = [
  "ThirdPartySystem_ContractorID", "ContractorName", "ContractorComments", "ContractorCategory",
  "ABN", "EmailAddress", "PhoneNumber", "MobileNumber", "ContactFirstName", "ContactLastName",
] as const;
const CONTRACTOR_BOOL_FIELDS = ["Active", "Suspended"] as const;
const MAX_CONTRACTORS_PER_CALL = 100;
const MAX_STRING_LENGTH = 500;

type SanitiseResult = { ok: true; contractors: MyContractor[] } | { ok: false; error: string };

/** Allowlisted, size-capped copy of the request's contractors, or why not. */
export function sanitiseContractors(body: unknown): SanitiseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be an object" };
  const b = body as UpdateContractorsBody;
  const raw = b.Contractors ?? b.contractors ?? [body];
  if (!Array.isArray(raw)) return { ok: false, error: "Contractors must be an array" };
  if (raw.length === 0) return { ok: false, error: "Contractors must not be empty" };
  if (raw.length > MAX_CONTRACTORS_PER_CALL) return { ok: false, error: `At most ${MAX_CONTRACTORS_PER_CALL} contractors per request` };

  const contractors: MyContractor[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: `Contractors[${i}] must be an object` };
    const src = item as Record<string, unknown>;
    const out: MyContractor = {};
    if (src.ContractorID !== undefined) {
      if (typeof src.ContractorID !== "number" || !Number.isInteger(src.ContractorID) || src.ContractorID <= 0) {
        return { ok: false, error: `Contractors[${i}].ContractorID must be a positive integer` };
      }
      out.ContractorID = src.ContractorID;
    }
    for (const field of CONTRACTOR_STRING_FIELDS) {
      const v = src[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") return { ok: false, error: `Contractors[${i}].${field} must be a string` };
      if (v.length > MAX_STRING_LENGTH) return { ok: false, error: `Contractors[${i}].${field} exceeds ${MAX_STRING_LENGTH} characters` };
      out[field] = v;
    }
    for (const field of CONTRACTOR_BOOL_FIELDS) {
      const v = src[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== "boolean") return { ok: false, error: `Contractors[${i}].${field} must be true or false` };
      out[field] = v;
    }
    if (Object.keys(out).length === 0) return { ok: false, error: `Contractors[${i}] has no recognised fields` };
    contractors.push(out);
  }
  return { ok: true, contractors };
}

function contractorSubjectId(c: MyContractor): number | string {
  return c.ContractorID ?? c.ThirdPartySystem_ContractorID ?? "new";
}

// POST /api/syncContractors - fetch from myBuildings and upsert into SQL
async function syncContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  let connection;
  try {
    context.log("Fetching contractors from myBuildings API...");
    const contractors = await fetchAllContractors();
    context.log(`Fetched ${contractors.length} contractors`);

    connection = await createRequestConnection(token);
    let inserted = 0;
    let updated = 0;

    for (const c of contractors) {
      const existing = await executeQuery(connection,
        "SELECT Id FROM Contractors WHERE ContractorID = @ContractorID",
        [{ name: "ContractorID", type: TYPES.Int, value: c.ContractorID }]
      );

      const p = contractorToParams(c);

      if (existing.length > 0) {
        await executeQuery(connection,
          `UPDATE Contractors SET
           ThirdPartySystem_ContractorID=@ThirdPartyContractorID,
           ContractorName=@ContractorName, ContractorComments=@ContractorComments,
           ContractorCategory=@ContractorCategory, ABN=@ABN, Active=@Active,
           Suspended=@Suspended, EmailAddress=@EmailAddress,
           PhoneNumber=@PhoneNumber, MobileNumber=@MobileNumber,
           ContactFirstName=@ContactFirstName, ContactLastName=@ContactLastName,
           LastSyncedAt=GETUTCDATE(), UpdatedAt=GETUTCDATE()
           WHERE ContractorID=@ContractorID`, p);
        updated++;
      } else {
        await executeQuery(connection,
          `INSERT INTO Contractors (ContractorID, ThirdPartySystem_ContractorID,
           ContractorName, ContractorComments, ContractorCategory, ABN, Active,
           Suspended, EmailAddress, PhoneNumber, MobileNumber,
           ContactFirstName, ContactLastName,
           LastSyncedAt, CreatedAt, UpdatedAt)
           VALUES (@ContractorID, @ThirdPartyContractorID,
           @ContractorName, @ContractorComments, @ContractorCategory, @ABN, @Active,
           @Suspended, @EmailAddress, @PhoneNumber, @MobileNumber,
           @ContactFirstName, @ContactLastName,
           GETUTCDATE(), GETUTCDATE(), GETUTCDATE())`, p);
        inserted++;
      }
    }

    return { status: 200, jsonBody: { message: "Sync complete", total: contractors.length, inserted, updated } };
  } catch (error: any) {
    context.error("Sync failed:", error.message);
    return errorResponse("Sync failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// GET /api/getContractors - query from local database
async function getContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Accounts + facilities staff both need to look contractor names up when
  // filling out jobs / invoices / POs — gating either side out forced them
  // through a manager for a read that's already non-sensitive (name /
  // category / contact details).
  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  let connection;
  try {
    connection = await createRequestConnection(token);

    const contractorId = request.query.get("contractorId");
    const active = request.query.get("active");

    let sql = `SELECT
      ContractorID, ContractorName, ContractorCategory,
      ABN, Active, Suspended,
      EmailAddress, PhoneNumber, MobileNumber
    FROM Contractors WHERE 1=1`;
    const params: SqlParam[] = [];

    if (contractorId) {
      sql += " AND ContractorID = @ContractorID";
      params.push({ name: "ContractorID", type: TYPES.Int, value: parseInt(contractorId) });
    }
    if (active !== null && active !== undefined) {
      sql += " AND Active = @Active";
      params.push({ name: "Active", type: TYPES.Bit, value: active === "true" });
    }

    sql += " ORDER BY ContractorName";
    const rows = await executeQuery(connection, sql, params);

    return { status: 200, jsonBody: { contractors: rows, count: rows.length } };
  } catch (error: any) {
    context.error("Query failed:", error.message);
    return errorResponse("Query failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// PUT /api/updateContractors - create/update via myBuildings API
async function handleUpdateContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  let connection;
  try {
    const body: unknown = await request.json().catch(() => null);
    const sanitised = sanitiseContractors(body);
    if (!sanitised.ok) return { status: 400, jsonBody: { error: sanitised.error } };
    const { contractors } = sanitised;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    context.log(`Updating ${contractors.length} contractors via myBuildings API...`);
    const result = await createOrUpdateContractors(contractors);

    // One ledger row per contractor: what Floorplan sent, after the write succeeded.
    for (const c of contractors) {
      await record(connection, {
        action: "contractor.update",
        actor,
        after: c,
        subject: { id: contractorSubjectId(c), type: "contractor" },
      });
    }
    return { status: 200, jsonBody: { message: "Contractors updated", result } };
  } catch (error: any) {
    context.error("Update failed:", error.message);
    return errorResponse("Update failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

function contractorToParams(c: MyContractor) {
  return [
    { name: "ContractorID", type: TYPES.Int, value: c.ContractorID ?? null },
    { name: "ThirdPartyContractorID", type: TYPES.NVarChar, value: c.ThirdPartySystem_ContractorID ?? null },
    { name: "ContractorName", type: TYPES.NVarChar, value: c.ContractorName ?? null },
    { name: "ContractorComments", type: TYPES.NVarChar, value: c.ContractorComments ?? null },
    { name: "ContractorCategory", type: TYPES.NVarChar, value: c.ContractorCategory ?? null },
    { name: "ABN", type: TYPES.NVarChar, value: c.ABN ?? null },
    { name: "Active", type: TYPES.Bit, value: c.Active ?? true },
    { name: "Suspended", type: TYPES.Bit, value: c.Suspended ?? false },
    { name: "EmailAddress", type: TYPES.NVarChar, value: c.EmailAddress ?? null },
    { name: "PhoneNumber", type: TYPES.NVarChar, value: c.PhoneNumber ?? null },
    { name: "MobileNumber", type: TYPES.NVarChar, value: c.MobileNumber ?? null },
    { name: "ContactFirstName", type: TYPES.NVarChar, value: c.ContactFirstName ?? null },
    { name: "ContactLastName", type: TYPES.NVarChar, value: c.ContactLastName ?? null },
  ];
}

app.http("syncContractors", { methods: ["POST"], authLevel: "anonymous", handler: syncContractors });
app.http("getContractors", { methods: ["GET"], authLevel: "anonymous", handler: getContractors });
app.http("updateContractors", { methods: ["PUT"], authLevel: "anonymous", handler: handleUpdateContractors });
