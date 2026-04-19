// Formats PO / Quote document numbers:
//   YYMMDD-{prefix}-{jobId}-{acronym}-{seq}
// e.g. "260419-PO-42-ACM-7" or "260419-Q-42-INT-3"
//
// `prefix` is "PO" or "Q". `acronym` is the contractor's 3-letter code, or
// "INT" for internal jobs with no contractor.

export function formatYYMMDD(now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function formatDocNumber(input: {
  prefix: "PO" | "Q";
  jobId: number;
  acronym: string;
  seq: number;
  now?: Date;
}): string {
  const { prefix, jobId, acronym, seq, now } = input;
  return `${formatYYMMDD(now)}-${prefix}-${jobId}-${acronym}-${seq}`;
}
