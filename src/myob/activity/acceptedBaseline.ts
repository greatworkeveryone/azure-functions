// What "accept MYOB's record as the baseline" may cover, and whether it
// happened (m4c review, 18 Oct).
//   acceptanceProblems  the fields she may accept are the ones that aren't
//     Floorplan's money or identity: memo, comment, line descriptions, dates
//     other than the record's date, freight, and MYOB's status. A difference
//     in amount, tax-inclusive, supplier, account, tax code, number, the
//     record's date, the lines themselves, or anything else is refused:
//     "accept MYOB's value into Floorplan" isn't built, and accepting it would
//     leave Floorplan's record and MYOB's disagreeing with nothing to say so.
//   baselineAccepted  the ledger's record of her acceptance for a proposal;
//     "Update in MYOB" is refused on such a record until a PUT built on the
//     accepted record is proven, so nothing she accepted is overwritten.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import type { DiscrepancyField } from "../readbackCompare";

const ACCEPTABLE = [/^JournalMemo$/, /^Comment$/, /^Lines\[\d+\]\.Description$/, /^(?!Date$)(?:[A-Za-z]+\.)*[A-Za-z]*Date$/, /^Freight$/, /^FreightTaxCode\.UID$/, /^status$/];

/** The labels of the differences she may not accept; empty when all of them may be. */
export function acceptanceProblems(fields: readonly DiscrepancyField[]): string[] {
  return fields.filter((field) => !ACCEPTABLE.some((pattern) => pattern.test(field.field))).map((field) => field.label);
}

export async function baselineAccepted(connection: Connection, correlationId: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 1 AS Accepted FROM dbo.DecisionLedger
      WHERE Action = N'myob.control_change' AND RuleApplied = N'accept_baseline' AND CorrelationId = @Correlation`,
    [{ name: "Correlation", type: TYPES.UniqueIdentifier, value: correlationId }],
  );
  return rows.length > 0;
}
