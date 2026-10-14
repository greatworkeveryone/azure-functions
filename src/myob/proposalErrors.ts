// A proposal action Floorplan refused, with the plain reasons the person sees.

export class ProposalError extends Error {
  readonly reasons: string[];
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, ...reasons: string[]) {
    super(reasons.join(" "));
    this.name = "ProposalError";
    this.reasons = reasons;
    this.status = status;
  }
}

/** A preview is good for 10 minutes: long enough to read, short enough that the record hasn't moved on. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export function checkPreviewTime(previewedAt: Date, now: Date): void {
  const age = now.getTime() - previewedAt.getTime();
  if (Number.isNaN(age) || age < -CLOCK_SKEW_MS) throw new ProposalError(400, "The preview time isn't valid. Preview again.");
  if (age > PREVIEW_TTL_MS) throw new ProposalError(409, "That preview is more than 10 minutes old. Preview again.");
}
