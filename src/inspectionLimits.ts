// Size limits on what an inspector types. Kept apart from the endpoints so the
// removal ledger can rely on them (inspectionRemovalLedger.ts).

/** The longest text one inspection point may hold, in UTF-16 characters (what a browser's maxLength counts).
 *  InspectionPoints.Description is NVARCHAR(MAX); the cap is what keeps a point's row in the removal ledger
 *  under the ledger's own size limit (worst case about 30 KB of JSON, for text that is all control characters). */
export const MAX_POINT_DESCRIPTION_LENGTH = 5000;

/** A refusal whose text is written for the person and is safe to show: the op rejection reason
 *  passes it through in production, where other errors are reported generically. */
export class OpRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpRefusal";
  }
}

/** Throws an OpRefusal when `text` is a string longer than the point-text cap. */
export function assertPointTextLength(text: unknown, op: "addPoint" | "updatePoint"): void {
  if (typeof text === "string" && text.length > MAX_POINT_DESCRIPTION_LENGTH) {
    throw new OpRefusal(
      `${op}: the note is ${text.length} characters long; the limit is ${MAX_POINT_DESCRIPTION_LENGTH}. Shorten it and try again.`,
    );
  }
}
