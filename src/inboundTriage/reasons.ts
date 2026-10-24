// Inbound email triage (EB3): keeps what a ranker returns short enough to show and to log.

import type { Reason } from "./types";

const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 200;

/** At most a few lines of plain text, each one a sentence's length: nothing a ranker returns can swamp a screen or a log row. */
export function tidyReasons(reasons: readonly Reason[] | undefined): Reason[] {
  return (Array.isArray(reasons) ? reasons : [])
    .filter((reason) => typeof reason?.text === "string" && reason.text.trim() !== "")
    .slice(0, MAX_REASONS)
    .map((reason) => ({ caution: reason.caution === true, text: reason.text.trim().slice(0, MAX_REASON_LENGTH) }));
}
