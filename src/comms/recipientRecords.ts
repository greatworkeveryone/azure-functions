// A recipient is whoever the server's own records say, never what the request says (EB1 security review M3).
//
// The request names a type, a record id and an address. The address is only accepted when it is the stored
// contact of that record: a tenancy's primary or accounts email, a contractor's email, a staff member's
// email. A tenancy that is a test record never gets mail; a typed (manual) address that is any test tenancy's
// contact is refused too, so a test contact can't be reached by calling it something else. The queue asks
// this when a job is made and again at send time, and the egress guard reads this answer.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import type { RecipientType } from "./compose";

export interface RecipientClaim {
  /** Lower-case, as parsed. */
  address: string;
  recipientRefId: string | null;
  recipientType: RecipientType;
}

export type RefusalCode = "address_mismatch" | "test_record" | "unknown_record";

export type Resolution = { ok: true } | { code: RefusalCode; detail: string; ok: false };

const REF = /^[1-9]\d{0,9}$/;
const PRIMARY_IS_ADDRESS = "LOWER(LTRIM(RTRIM(PrimaryContactEmail))) = @Address";
const ACCOUNTS_IS_ADDRESS = "LOWER(LTRIM(RTRIM(AccountsEmail))) = @Address";
const CONTRACTOR_IS_ADDRESS = "LOWER(LTRIM(RTRIM(EmailAddress))) = @Address";
const STAFF_IS_ADDRESS = "LOWER(LTRIM(RTRIM(Email))) = @Address";

const TENANCY_SQL = `SELECT IsTest, CASE WHEN ArchivedAt IS NULL THEN 0 ELSE 1 END AS Archived,
    CASE WHEN ${PRIMARY_IS_ADDRESS} OR ${ACCOUNTS_IS_ADDRESS} THEN 1 ELSE 0 END AS Matches
  FROM dbo.Tenants WHERE TenantId = @Id`;
const CONTRACTOR_SQL = `SELECT CASE WHEN ${CONTRACTOR_IS_ADDRESS} THEN 1 ELSE 0 END AS Matches FROM dbo.Contractors WHERE ContractorID = @Id`;
const STAFF_SQL = `SELECT CASE WHEN ${STAFF_IS_ADDRESS} THEN 1 ELSE 0 END AS Matches FROM dbo.AppUsers WHERE UserID = @Id`;
const TEST_CONTACT_SQL = `SELECT TOP (1) 1 AS Hit FROM dbo.Tenants WHERE IsTest = 1 AND (${PRIMARY_IS_ADDRESS} OR ${ACCOUNTS_IS_ADDRESS})`;

const refuse = (code: RefusalCode, detail: string): Resolution => ({ code, detail, ok: false });
const NOT_THE_CONTACT = "That address isn't the recorded contact for that record";
const NO_RECORD = "No such record to send to";

export async function resolveRecipientRecord(connection: Connection, claim: RecipientClaim): Promise<Resolution> {
  const address = { name: "Address", type: TYPES.NVarChar, value: claim.address.trim().toLowerCase() };
  if (claim.recipientType === "manual") {
    const rows = await executeQuery(connection, TEST_CONTACT_SQL, [address]);
    return rows.length > 0 ? refuse("test_record", "That address belongs to a test record") : { ok: true };
  }
  if (claim.recipientRefId === null || !REF.test(claim.recipientRefId)) return refuse("unknown_record", NO_RECORD);
  const id = { name: "Id", type: TYPES.Int, value: Number(claim.recipientRefId) };
  if (claim.recipientType === "tenancy") {
    const [row] = await executeQuery(connection, TENANCY_SQL, [id, address]);
    if (!row || Number(row.Archived) === 1) return refuse("unknown_record", NO_RECORD);
    if (row.IsTest === true || row.IsTest === 1) return refuse("test_record", "That tenancy is a test record");
    return Number(row.Matches) === 1 ? { ok: true } : refuse("address_mismatch", NOT_THE_CONTACT);
  }
  const [row] = await executeQuery(connection, claim.recipientType === "contractor" ? CONTRACTOR_SQL : STAFF_SQL, [id, address]);
  if (!row) return refuse("unknown_record", NO_RECORD);
  return Number(row.Matches) === 1 ? { ok: true } : refuse("address_mismatch", NOT_THE_CONTACT);
}
