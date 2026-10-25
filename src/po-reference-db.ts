// DB-facing half of PO numbering in Johanne's format (see reference-codes.ts
// for the pure half). Kept apart so the formatter stays testable without a
// connection, like contractor-acronym-db.ts.

import { Connection, TYPES } from "tedious";
import { executeQuery } from "./db";
import {
  chargeCodeForJob,
  formatPoReference,
  isChargeCode,
  poReferenceBase,
} from "./reference-codes";

export interface ResolvedPoNumber {
  poNumber: string;
  /** Always set, even on the fallback path, so the PO keeps its charge code. */
  chargeCode: string;
  /** Why the legacy number was used instead; the caller logs it once. */
  warning: string | null;
}

/**
 * `{ReferenceCode}{chargeCode}{YYMMDD}` for a new PO, or `fallbackPoNumber`
 * when that cannot be built. A missing building mapping must never block
 * work, so every failure degrades to the fallback with a warning.
 *
 * Must run inside the PO-create transaction: the UPDLOCK/HOLDLOCK read of
 * existing numbers is what stops two concurrent creates taking the same
 * suffix.
 */
export async function resolvePoNumber(
  connection: Connection,
  input: {
    jobId: number;
    /** Raw body value; used only if it is a listed charge code. */
    requestedChargeCode?: unknown;
    fallbackPoNumber: string;
    now?: Date;
  },
): Promise<ResolvedPoNumber> {
  const { jobId, fallbackPoNumber, now = new Date() } = input;

  const jobRows = await executeQuery(
    connection,
    `SELECT j.Category, j.[Type] AS JobType, j.SubType, b.ReferenceCode
       FROM Jobs j
       LEFT JOIN Buildings b ON b.BuildingID = j.BuildingID
      WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  const job = jobRows[0];

  const requested =
    typeof input.requestedChargeCode === "string" ? input.requestedChargeCode.trim() : input.requestedChargeCode;
  const chargeCode = isChargeCode(requested)
    ? requested
    : chargeCodeForJob({
        category: (job?.Category as string | null) ?? null,
        type: (job?.JobType as string | null) ?? null,
        subType: (job?.SubType as string | null) ?? null,
      });

  const buildingCode = (job?.ReferenceCode as string | null) ?? null;
  if (!buildingCode) {
    return {
      poNumber: fallbackPoNumber,
      chargeCode,
      warning: `Job ${jobId}: its building has no ReferenceCode, so PO ${fallbackPoNumber} uses the legacy number format. Map the building (Buildings.ReferenceCode).`,
    };
  }

  // Only formatting failures degrade to the legacy number; a database error
  // must still abort the transaction.
  let base: string;
  try {
    base = poReferenceBase({ buildingCode, chargeCode, date: now });
  } catch (err: unknown) {
    return fallback(err);
  }
  const existing = await executeQuery(
    connection,
    `SELECT PONumber FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PONumber LIKE @Prefix`,
    [{ name: "Prefix", type: TYPES.NVarChar, value: `${base}%` }],
  );
  try {
    const poNumber = formatPoReference({
      buildingCode,
      chargeCode,
      date: now,
      existing: existing.map((r) => r.PONumber as string).filter((n) => typeof n === "string"),
    });
    return { poNumber, chargeCode, warning: null };
  } catch (err: unknown) {
    return fallback(err);
  }

  function fallback(err: unknown): ResolvedPoNumber {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      poNumber: fallbackPoNumber,
      chargeCode,
      warning: `Job ${jobId}: could not build a reference-format PO number (${reason}); using legacy ${fallbackPoNumber}.`,
    };
  }
}
