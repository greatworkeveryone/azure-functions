// What each escalation policy is for, in words an admin can read before switching it: the moment it starts, in one
// sentence. Who is told, and how fast it moves up, is read from the policy's own ladder (`describeLadder`), so that
// part can never disagree with what the engine does. A policy with no entry here still lists, with a plain "no
// description" line, so a new policy is never hidden from the switch screen.

import type { LadderEntry } from "./types";
import { roleLabel } from "./roles";

export const POLICY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "any.manual": "Someone escalates any record by hand.",
  "billing.run_approval": "A billing run is waiting for approval.",
  "comms.arrears_exhausted": "An arrears reminder sequence ran out with the tenant still owing.",
  "comms.broadcast_approval": "A broadcast email is held for approval before it goes out.",
  "comms.contractor_no_reply": "A contractor has not answered a request.",
  "comms.legal_notice_approval": "A legal notice is held for approval.",
  "contractor.contact_changed": "A contractor's email or ABN was changed and a second person has to confirm it. Seeded on.",
  "cover.moved": "Someone's work was handed to their cover while they are away.",
  "defects_period.ends_in_30": "A defects period ends in 30 days.",
  "defects_period.ends_in_60": "A defects period ends in 60 days.",
  "job.approval_waiting": "A quote or invoice has waited two business days for a director. Raised by the escalation sweep, so it also needs the sweep live.",
  "job.critical": "A job is raised as critical.",
  "job.decision_pending": "Someone was asked for a decision on a job and has not answered.",
  "job.hold_overdue": "A job on hold, or marked stalled, passed its next-update date. Raised by the escalation sweep, so it also needs the sweep live.",
  "job.invoice_waiting": "An invoice has waited too long for approval.",
  "job.manual": "Someone escalates a job by hand.",
  "job.next_step": "A job was handed on with a next step that is not done yet.",
  "job.past_due": "A job passed its due date.",
  "job.quote_not_back": "A quote request has had no answer for too long.",
  "job.stalled_unacknowledged": "A job has not moved for too long and nobody picked it up.",
  "job.unassigned": "A job has had nobody assigned for too long.",
  "lease.option_approval": "A lease option notice was recorded and waits for approval. A late notice starts at a director.",
  "lease.option_deadline": "A lease option deadline is coming up.",
  "lease.option_lapsed": "A lease option deadline passed with nothing recorded.",
  "lease.renewal": "A lease is coming up for renewal.",
  "leave.decision": "Leave was asked for and waits for a decision.",
  "po.variance_disputed": "A purchase order cost difference was disputed.",
  "po.variance_notice": "A purchase order costs more than the quote it follows.",
  "procedure.approval": "A procedure draft was sent for approval.",
  "quote.attribution_disputed": "A quote approval recorded on someone's behalf was disputed.",
  "quote.attribution_notice": "A quote was approved on someone's behalf, so they are told.",
  "rent_review.approval": "A rent review is ready for approval.",
  "rent_review.closeout": "A rent review is settled and has loose ends to close.",
  "rent_review.index_late": "The index figure for a rent review is late.",
  "rent_review.market_referral": "A rent review needs a market valuation.",
  "rent_review.not_commenced": "A rent review should have started and has not.",
  "rent_review.overdue": "A rent review is past its date.",
  "schedule.change_ratification": "A change to a tenancy schedule needs ratifying.",
  "service_schedule.overdue": "A service is overdue.",
  "service_schedule.overdue_urgent": "A fire or lift service is overdue, marked urgent.",
  "system.health": "Floorplan itself has a problem, such as a stopped timer or a missing setting.",
  "tenancy.schedule_unsigned": "A tenancy schedule is unsigned and its review date is near or past. Raised by the escalation sweep, so it also needs the sweep live.",
};

export const NO_DESCRIPTION = "No description yet. Ask whoever added this policy what it does before switching it.";

export function describePolicy(policyKey: string): string {
  return POLICY_DESCRIPTIONS[policyKey] ?? NO_DESCRIPTION;
}

/** "Accounts manager after 16 hours, then CFO after 16 hours, then Director", from the stored ladder. */
export function describeLadder(ladder: readonly LadderEntry[], clock: "business" | "wall"): string {
  const unit = clock === "wall" ? "hours" : "business hours";
  return ladder
    .map((level) => {
      const who = level.role ? roleLabel(level.role) : level.token === "raiser_manager" ? "The raiser's manager" : level.token === "authority_route" ? "Whoever may approve it" : "The person named";
      return level.slaHours ? `${who} (${level.slaHours} ${unit})` : who;
    })
    .join(", then ");
}
