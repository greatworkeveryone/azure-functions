// When a "pushed" proposal can no longer be mid-send (decision 12). A push is
// find, create or update, and read back; each MYOB call times out at 30 s and
// may be retried once on a 429, and the token refresh before it can wait on
// another instance's refresh lock. Fifteen minutes is comfortably past all of
// that. After it, the proposal may be sent again (the lookup by number links a
// record the first try created) or withdrawn with a warning that MYOB may
// already hold it.

import type { ProposalRow } from "./proposalRow";

export const PUSH_STALE_MS = 15 * 60_000;

/** True while a pushed proposal may still be talking to MYOB. */
export function pushInFlight(proposal: Pick<ProposalRow, "pushedAt" | "state">, now: Date): boolean {
  return proposal.state === "pushed" && proposal.pushedAt !== null && now.getTime() - Date.parse(proposal.pushedAt) <= PUSH_STALE_MS;
}
