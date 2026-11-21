// SECS-02: can a promoted email's sender be taken as the contractor it names?
// From is spoofable, so an email counts as verified only when its sender was
// authenticated at intake (SenderAuthenticated, src/email/sender-auth.ts) AND,
// the contractor has an address on record AND the From address is that one.
// With no address on record there is nothing to compare, so that is not
// verified either (REV-05). Anything else needs the person promoting to say
// they checked another way.
// Pure except contractorAddressOf.
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";

export type SenderCheck = "verified" | "unverified" | "mismatch" | "no_address";

export interface SenderAssessment {
  check: SenderCheck;
  /** The From address of the email, as received (null when the row had none). */
  senderAddress: string | null;
}

export interface EmailSenderRow {
  FromAddress?: unknown;
  SenderAuthenticated?: unknown;
  Source?: unknown;
}

const normalise = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** An unauthenticated sender outranks an address mismatch: it is the weaker fact. */
export function assessSender(email: EmailSenderRow, contractorAddress: string | null | undefined): SenderAssessment {
  const from = normalise(email.FromAddress);
  const senderAddress = from === "" ? null : from;
  // Only mail read from the mailbox carries a verdict; a row filed through the ingest endpoint has a caller-supplied From.
  const authenticated = email.SenderAuthenticated === true || email.SenderAuthenticated === 1;
  if (email.Source !== "graph" || !authenticated) return { check: "unverified", senderAddress };
  const onRecord = normalise(contractorAddress);
  if (onRecord === "") return { check: "no_address", senderAddress };
  if (onRecord !== from) return { check: "mismatch", senderAddress };
  return { check: "verified", senderAddress };
}

export async function contractorAddressOf(connection: Connection, contractorId: number | null | undefined): Promise<string | null> {
  if (typeof contractorId !== "number" || !Number.isInteger(contractorId)) return null;
  const rows = await executeQuery(connection, "SELECT EmailAddress FROM dbo.Contractors WHERE ContractorID = @Id", [
    { name: "Id", type: TYPES.Int, value: contractorId },
  ]);
  const address = rows[0]?.EmailAddress;
  return typeof address === "string" && address.trim() !== "" ? address : null;
}

/** What the 422 says. Plain words; the screen shows `error` as it is. */
export function senderRefusalBody(assessment: SenderAssessment) {
  const who = assessment.senderAddress ?? "an unknown address";
  return {
    code: "sender_unverified",
    error:
      assessment.check === "mismatch"
        ? `This message came from ${who}, which is not the contractor's address on record. Confirm that you have checked it another way.`
        : assessment.check === "no_address"
          ? `There is no address on record to check ${who} against. Confirm that you have checked it another way.`
          : `This message could not be verified as coming from ${who}. Confirm that you have checked it another way.`,
    senderAddress: assessment.senderAddress,
    senderCheck: assessment.check,
  };
}

/** The columns every promoted record carries (migration 197). */
export function senderRecordParams(assessment: SenderAssessment, confirmedBy: string | null) {
  const confirmed = assessment.check !== "verified";
  return [
    { name: "SenderCheck", type: TYPES.NVarChar, value: assessment.check },
    { name: "SenderAddress", type: TYPES.NVarChar, value: assessment.senderAddress },
    { name: "SenderConfirmedBy", type: TYPES.NVarChar, value: confirmed ? confirmedBy : null },
    { name: "SenderConfirmedAt", type: TYPES.DateTime2, value: confirmed ? new Date() : null },
  ];
}
