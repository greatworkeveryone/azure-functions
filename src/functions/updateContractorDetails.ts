// PUT /api/updateContractorDetails — correct one contractor's name, contact details and ABN.
//
// Floorplan is becoming the home of contractor records; myBuildings is kept in step while it is
// still in use. So the edit is written to dbo.Contractors first and pushed to myBuildings inside
// the same transaction: both change or neither does. A Floorplan-only change would be reverted
// by the next syncContractors pull, which copies myBuildings over this table. The push sends
// myBuildings its own current record with only the edited fields replaced, so nothing it holds
// that Floorplan does not (spare fields, comments) is blanked. MYBUILDINGS_CONTRACTOR_PUSH="false"
// stops the push for the day myBuildings is retired.
//
// The client sends the version it loaded (UpdatedAt as text, from getContractors); a stale one
// is a 409 and nothing is written. Every change is a ledger exception with before and after:
// a changed email redirects purchase orders, so a changed email or ABN also starts the SECA-04 hold:
// a purchase order to that contractor needs the sender's tick until a second person confirms
// (confirmContractorContact) or two business days pass.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { isStaging } from "../config/stagingGuard";
import { MANAGE_SERVICE_SCHEDULES_ROLES } from "../facilitiesRoles";
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk } from "../assetRegisterSupport";
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from "../db";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { createOrUpdateContractors, fetchContractorById, type MyContractor } from "../mybuildings-client";

export const CONTRACTOR_DETAIL_FIELDS = [
  "ContractorName", "ContactFirstName", "ContactLastName", "PhoneNumber", "MobileNumber", "EmailAddress", "ABN",
] as const;
type DetailField = (typeof CONTRACTOR_DETAIL_FIELDS)[number];
export type ContractorDetails = Record<DetailField, string | null>;

const MAX_LENGTH = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ParseResult = { ok: true; contractorId: number; details: ContractorDetails; version: string } | { ok: false; error: string };

/** The allowlisted, trimmed details (blank → null), or why not. Pure. */
export function parseContractorDetails(body: Record<string, unknown>): ParseResult {
  const contractorId = body.contractorId;
  if (typeof contractorId !== "number" || !Number.isInteger(contractorId) || contractorId <= 0) return { error: "contractorId must be a positive integer", ok: false };
  if (typeof body.version !== "string") return { error: "version must be the value the record was loaded with", ok: false };
  const details = {} as ContractorDetails;
  for (const field of CONTRACTOR_DETAIL_FIELDS) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") return { error: `${field} must be text`, ok: false };
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length > MAX_LENGTH) return { error: `${field} is longer than ${MAX_LENGTH} characters`, ok: false };
    details[field] = trimmed === "" ? null : trimmed;
  }
  if (!details.ContractorName) return { error: "A contractor needs a name", ok: false };
  if (details.EmailAddress && !EMAIL.test(details.EmailAddress)) return { error: "That email address doesn't look complete", ok: false };
  if (details.ABN) {
    const digits = details.ABN.replace(/\s/g, "");
    if (!/^\d{11}$/.test(digits)) return { error: "An ABN is 11 digits", ok: false };
    details.ABN = digits;
  }
  return { contractorId, details, ok: true, version: body.version };
}

// Staging never writes to the real myBuildings, whatever the setting says (config/stagingGuard.ts).
const pushEnabled = () => !isStaging() && process.env.MYBUILDINGS_CONTRACTOR_PUSH !== "false";

/** An email or ABN change is the one that redirects money, so it starts the SECA-04 hold (contractorContactHold.ts). */
export function contactDetailsChanged(before: Pick<ContractorDetails, "ABN" | "EmailAddress">, after: Pick<ContractorDetails, "ABN" | "EmailAddress">): boolean {
  const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
  return norm(before.EmailAddress) !== norm(after.EmailAddress) || norm(before.ABN) !== norm(after.ABN);
}

const SELECT_ROW = `SELECT ContractorID, ContractorName, ContactFirstName, ContactLastName, PhoneNumber, MobileNumber, EmailAddress, ABN,
  COALESCE(CONVERT(varchar(33), UpdatedAt, 126), '') AS Version
  FROM dbo.Contractors WITH (UPDLOCK, HOLDLOCK) WHERE ContractorID = @Id`;

export async function updateContractorDetails(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_SERVICE_SCHEDULES_ROLES);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parseContractorDetails(body);
  if (!input.ok) return badRequest(input.error);

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const actor = await resolveLedgerActor(request, conn);
    if (!actor) return { jsonBody: { error: "Unauthorised" }, status: 401 };
    const idParam: SqlParam = { name: "Id", type: TYPES.Int, value: input.contractorId };

    const result = await inTransaction(conn, async () => {
      const before = (await executeQuery(conn, SELECT_ROW, [idParam]))[0] as (ContractorDetails & { Version: string }) | undefined;
      if (!before) return txFail(notFound("That contractor isn't in Floorplan"));
      if (before.Version !== input.version) return txFail(conflict("Someone else changed this contractor. Reload to see their version."));

      const contactChanged = contactDetailsChanged(before, input.details);
      const params: SqlParam[] = [idParam, ...CONTRACTOR_DETAIL_FIELDS.map((field) => ({ name: field, type: TYPES.NVarChar, value: input.details[field] }))];
      await executeQuery(
        conn,
        `UPDATE dbo.Contractors SET ${CONTRACTOR_DETAIL_FIELDS.map((field) => `${field}=@${field}`).join(", ")}, UpdatedAt=GETUTCDATE()${
          contactChanged
            ? ", ContactChangedAt=SYSUTCDATETIME(), ContactChangedBy=@ChangedBy, ContactChangedByOid=@ChangedByOid, ContactConfirmedAt=NULL, ContactConfirmedBy=NULL"
            : ""
        } WHERE ContractorID=@Id`,
        contactChanged
          ? [...params, { name: "ChangedBy", type: TYPES.NVarChar, value: actor.name }, { name: "ChangedByOid", type: TYPES.NVarChar, value: auth.caller.oid }]
          : params,
      );
      const beforeDetails = Object.fromEntries(CONTRACTOR_DETAIL_FIELDS.map((field) => [field, before[field] ?? null]));
      await record(conn, {
        action: "contractor.update",
        actor,
        after: contactChanged ? { ...input.details, contactHeldForSecondPerson: true } : input.details,
        before: beforeDetails,
        subject: { id: input.contractorId, type: "contractor" },
      });

      if (pushEnabled()) {
        try {
          const current = await fetchContractorById(input.contractorId);
          if (!current) return txFail({ jsonBody: { error: "myBuildings has no record of this contractor, so nothing was saved. Ask an admin to check the contractor link." }, status: 502 });
          const edits: MyContractor = Object.fromEntries(CONTRACTOR_DETAIL_FIELDS.map((field) => [field, input.details[field] ?? ""]));
          await createOrUpdateContractors([{ ...current, ...edits, ContractorID: input.contractorId }]);
        } catch (error) {
          context.error("myBuildings contractor push failed:", (error as Error).message);
          return txFail({ jsonBody: { error: "myBuildings didn't accept the change, so nothing was saved. Try again in a minute." }, status: 502 });
        }
      }
      // If the commit after a successful push fails, myBuildings has the change and the next
      // sync brings it back here: the two still converge.
      const after = (await executeQuery(conn, "SELECT COALESCE(CONVERT(varchar(33), UpdatedAt, 126), '') AS Version FROM dbo.Contractors WHERE ContractorID=@Id", [idParam]))[0] as { Version: string };
      return txOk({ version: after.Version });
    });
    if (!result.ok) return result.response;
    return { jsonBody: { ...result.value, myBuildingsUpdated: pushEnabled() }, status: 200 };
  } catch (error) {
    context.error("updateContractorDetails failed:", (error as Error).message);
    return { jsonBody: { error: "The change couldn't be saved. Try again." }, status: 500 };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("updateContractorDetails", { authLevel: "anonymous", handler: updateContractorDetails, methods: ["PUT"] });
