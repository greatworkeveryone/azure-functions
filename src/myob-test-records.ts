// Which Floorplan record a MYOB call is about, and whether it is a test record
// (D9). myobRequest refuses a test record's call before anything leaves, and
// refuses a company-file write that names no record at all. The record is
// named by the caller (`record`) or found through the MYOB proposal its
// correlation id belongs to (M3's push, M10's read-back).

import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "./db";
import { readIsTest, type TestRecordKind } from "./test-data";

export interface MyobRecordRef {
  id: number;
  kind: Extract<TestRecordKind, "invoice" | "job" | "payment" | "purchase_order" | "quote">;
}

export interface MyobTestRecordQuery {
  correlationId: string | null;
  record: MyobRecordRef | null;
}

export interface MyobTestRecordVerdict {
  isTest: boolean;
  /** Whether the call could be tied to a Floorplan record at all. */
  named: boolean;
}

export type MyobTestRecordLookup = (query: MyobTestRecordQuery) => Promise<MyobTestRecordVerdict>;

export const PROPOSAL_SUBJECT_SQL = `IF OBJECT_ID(N'dbo.MyobProposals', N'U') IS NOT NULL
  SELECT TOP 1 SubjectType, SubjectId FROM dbo.MyobProposals WHERE CorrelationId = @CorrelationId`;

const PROPOSAL_KINDS: ReadonlySet<string> = new Set(["invoice", "purchase_order", "quote"]);

export const lookupMyobTestRecord: MyobTestRecordLookup = async ({ correlationId, record }) => {
  if (!record && !correlationId) return { isTest: false, named: false };
  const connection = await createServiceRequestConnection();
  try {
    let ref = record;
    if (!ref && correlationId) {
      const [row] = await executeQuery(connection, PROPOSAL_SUBJECT_SQL, [
        { name: "CorrelationId", type: TYPES.UniqueIdentifier, value: correlationId },
      ]);
      const kind = String(row?.SubjectType ?? "");
      if (row && PROPOSAL_KINDS.has(kind)) ref = { id: Number(row.SubjectId), kind: kind as MyobRecordRef["kind"] };
    }
    if (!ref) return { isTest: false, named: false };
    return { isTest: await readIsTest(connection, ref.kind, ref.id), named: true };
  } finally {
    closeConnection(connection);
  }
};
