// Formats PO / Quote / Invoice document numbers:
//   YYMMDD-{prefix}-{jobId}-{acronym}-{seq}
// e.g. "260419-PO-42-ACM-7" or "260419-QT-42-CR-3" or "260419-IV-42-CR-1"
//
// `prefix` is "PO", "QT", or "IV". `acronym` is the contractor's initials
// (first letter of each word, up to 3), or "INT" for internal jobs.

export function formatYYMMDD(now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function formatDocNumber(input: {
  prefix: "PO" | "QT" | "IV";
  jobId: number;
  acronym: string;
  seq: number;
  now?: Date;
}): string {
  const { prefix, jobId, acronym, seq, now } = input;
  return `${formatYYMMDD(now)}-${prefix}-${jobId}-${acronym}-${seq}`;
}

/** Derives a short acronym from a free-text contractor name (initials of up to
 *  3 words). Used when there is no ContractorID to look up a stored acronym. */
export function nameToAcronym(name: string): string {
  const ws = (name ?? "")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  if (ws.length === 0) return "UNK";
  return ws.slice(0, 3).map((w) => w[0]).join("");
}
