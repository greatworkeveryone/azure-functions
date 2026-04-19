// DB-facing helpers for contractor acronyms. Kept separate from the pure
// generator (contractor-acronym.ts) so the generator stays trivially testable
// without a DB connection.

import { Connection, TYPES } from "tedious";
import { executeQuery } from "./db";
import { generateAcronym } from "./contractor-acronym";

const INTERNAL_ACRONYM = "INT";

/**
 * Ensures the contractor has an Acronym. Returns the acronym.
 * Lazily populates on first call per contractor; later calls are no-ops.
 * Must be called inside a transaction that already holds enough locks to
 * serialize new PO/Quote numbering for the contractor — otherwise two
 * concurrent callers could both generate the same acronym.
 */
export async function ensureContractorAcronym(
  connection: Connection,
  contractorId: number,
): Promise<string> {
  const rows = await executeQuery(
    connection,
    `SELECT ContractorID, ContractorName, Acronym
       FROM Contractors WITH (UPDLOCK, HOLDLOCK)
      WHERE ContractorID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: contractorId }],
  );
  if (rows.length === 0) {
    throw new Error(`Contractor ${contractorId} not found`);
  }
  const existing = rows[0].Acronym as string | null;
  if (existing && existing.trim().length > 0) return existing;

  const taken = await executeQuery(
    connection,
    `SELECT Acronym FROM Contractors WHERE Acronym IS NOT NULL`,
  );
  const takenSet = new Set<string>(
    taken.map((r) => r.Acronym as string).filter((a) => !!a),
  );
  // Guard against colliding with the "INT" sentinel used for internal jobs.
  takenSet.add(INTERNAL_ACRONYM);

  const name = (rows[0].ContractorName as string) ?? "";
  const acronym = generateAcronym(name, takenSet);

  await executeQuery(
    connection,
    `UPDATE Contractors
        SET Acronym = @Acronym, UpdatedAt = SYSUTCDATETIME()
      WHERE ContractorID = @Id`,
    [
      { name: "Id", type: TYPES.Int, value: contractorId },
      { name: "Acronym", type: TYPES.NVarChar, value: acronym },
    ],
  );

  return acronym;
}

export { INTERNAL_ACRONYM };
