// What a push's result does to the proposal and what the CFO is told
// (decision 12). "pushed" is set at approval, before any MYOB call, so a
// second "Approve and send" can't start while one is in flight:
//   verified          MYOB holds what was sent
//   differs           sent, but MYOB holds something else: an exception
//   changed_in_myob   an update refused because someone edited it in MYOB
//   not_ours/failed   an exception, with MYOB's words
//   refused/dry_run   held back inside Floorplan: back to approved, sendable

import { myobWebUrl } from "../myob-purchase-order";
import type { ProposalRow, ProposalUpdate } from "./proposalsStore";
import { isHeldBack, KIND_OF, type PushResult, type RefusalReason } from "./sendSteps";

export function outcomeFields(result: PushResult, proposal: ProposalRow, at: Date): ProposalUpdate {
  if (isHeldBack(result)) return { PushedAt: null, State: "approved" };
  if (result.kind === "not_ours" || result.kind === "failed") return { MyobError: result.message.slice(0, 2000), State: "exception" };
  if (result.kind === "changed_in_myob") {
    return { Diff: JSON.stringify(result.diff), MyobError: "Changed in MYOB since Floorplan last saw it: reconcile by hand", State: "exception" };
  }
  return {
    Diff: JSON.stringify(result.diff),
    LastReadBackAt: at,
    MyobError: result.kind === "differs" ? "MYOB holds something different from what was sent: see the diff" : null,
    MyobNumber: String(result.readBack.Number ?? proposal.payload.Number ?? "").slice(0, 30),
    MyobRowVersion: result.readBack.RowVersion == null ? null : String(result.readBack.RowVersion),
    MyobUid: result.uid,
    MyobUrl: myobWebUrl(KIND_OF[proposal.operation], result.uid),
    PushedAt: at,
    ReadBack: JSON.stringify(result.readBack),
    State: result.kind === "verified" ? "verified" : "exception",
  };
}

/** The ledger action for an outcome; nothing for a request Floorplan held back (the approval is already ledgered). */
export function outcomeAction(result: PushResult): "myob.exception" | "myob.push" | null {
  if (isHeldBack(result)) return null;
  return result.kind === "verified" ? "myob.push" : "myob.exception";
}

const STAYS = "The proposal stays approved.";
const REFUSED: Record<RefusalReason, string> = {
  config: `Not sent: a MYOB setting is missing or malformed. ${STAYS}`,
  controls: `Not sent: Floorplan's MYOB controls don't allow it right now. ${STAYS}`,
  dry_run: "Dry run: the exact payload is logged and nothing was sent to MYOB.",
  not_allowed: `Not sent: the MYOB agreement doesn't allow that request. ${STAYS}`,
  not_floorplan_record: `Not sent: Floorplan didn't create that MYOB record, so it may not change it. ${STAYS}`,
  no_record: `Not sent: the MYOB request didn't name the Floorplan record it is for. ${STAYS}`,
  outside_period: `Not sent: MYOB's current-period rule refused it (Floorplan writes only records dated in the current period). ${STAYS}`,
  test_record: `Not sent: test record. Test records never go to MYOB. ${STAYS}`,
  writes_disabled: `Not sent: MYOB writes are switched off for this environment. ${STAYS}`,
};

const MESSAGES: Record<Exclude<PushResult["kind"], "dry_run" | "refused">, string> = {
  changed_in_myob: "Not sent: the record changed in MYOB since Floorplan last saw it. Johanne reconciles the difference by hand.",
  differs: "Sent, but MYOB holds something different from what was sent. See the differences.",
  failed: "Not sent.",
  not_ours: "Not sent.",
  verified: "Sent to MYOB and read back: it matches.",
};

export function outcomeMessage(result: PushResult): string {
  const lead = isHeldBack(result) ? REFUSED[result.reason] : MESSAGES[result.kind];
  const detail = "message" in result ? result.message : "";
  return `${lead} ${detail}`.trim();
}
