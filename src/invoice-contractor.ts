// Who an invoice is from, as a request names them.
//
// JobInvoices keeps the contractor's name and, since migration 112, their id.
// The id is stored only when the request gives it: from the picker, or from the
// quote or order the invoice answers. A free-text name is never matched against
// dbo.Contractors when an invoice is written, so a misspelling can't attach an
// invoice to the wrong contractor. (The decision ledger looks the id up from the
// name later, for invoices that have none; see ledger/moneyDecisions.)

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";

const INT_MAX = 2_147_483_647;

export type InvoiceContractor =
  | { error: string; ok: false }
  | {
      /** undefined: the request says nothing about the id. null: it says there is none. */
      id: number | null | undefined;
      /** The name to store, when the request or the id gives one. */
      name: string | null | undefined;
      ok: true;
    };

/**
 * Checks `ContractorID` (optional, from the request) and settles the name that
 * goes with it. An id has to be a whole number naming a contractor we have, or
 * the request is refused; a name that comes with it is kept as given, and when
 * none does it is the contractor's own.
 */
export async function resolveInvoiceContractor(
  connection: Connection,
  input: { ContractorID?: unknown; ContractorName?: unknown },
): Promise<InvoiceContractor> {
  const { ContractorID, ContractorName } = input;
  const given = ContractorName as string | null | undefined;

  if (ContractorID === undefined || ContractorID === null) return { id: ContractorID, name: given, ok: true };

  if (typeof ContractorID !== "number" || !Number.isInteger(ContractorID) || ContractorID < 1 || ContractorID > INT_MAX) {
    return { error: "ContractorID must be a whole number", ok: false };
  }
  const rows = await executeQuery(connection, "SELECT ContractorName FROM dbo.Contractors WHERE ContractorID = @ContractorID", [
    { name: "ContractorID", type: TYPES.Int, value: ContractorID },
  ]);
  if (rows.length === 0) return { error: "ContractorID does not match a contractor", ok: false };

  const hasName = typeof given === "string" && given.trim().length > 0;
  return { id: ContractorID, name: hasName ? given : ((rows[0].ContractorName as string | null) ?? null), ok: true };
}
