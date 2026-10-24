// Inbound email triage (EB3): assign automatically, or ask a manager. Pure. The rule is
// deliberately narrow, because a wrong automatic assignment sends someone's mail to the wrong
// desk and a queue entry costs a manager one tap.
//
// Automatic only when:
// - the email replies to a send, and the person who sent it is eligible (not away, not inactive):
//   they began the conversation, so it comes back to them; or
// - one person leads: their score reaches AUTO_MIN_SCORE, and they are ahead of the next by at
//   least AUTO_MIN_MARGIN (or nobody else is a candidate).
// Anything else goes to the manager's "Needs triage" queue with the top three.

import type { ScoredCandidate, TriageContext } from "./types";

export const AUTO_MIN_SCORE = 40;
export const AUTO_MIN_MARGIN = 15;
export const QUEUE_SUGGESTIONS = 3;

export type AutoRule = "reply_to_known_send" | "clear_leader";

export type Verdict = { chosen: ScoredCandidate; decision: "auto"; rule: AutoRule } | { decision: "queued"; rule: "weak_match" | "no_candidates" };

export function decide(ranked: readonly ScoredCandidate[], context: TriageContext): Verdict {
  if (ranked.length === 0) return { decision: "queued", rule: "no_candidates" };

  const senderId = context.linkedSend?.sentByUserId ?? null;
  const sender = senderId === null ? undefined : ranked.find((candidate) => candidate.userId === senderId);
  if (sender) return { chosen: sender, decision: "auto", rule: "reply_to_known_send" };

  const [first, second] = ranked;
  if (first.score >= AUTO_MIN_SCORE && (!second || first.score - second.score >= AUTO_MIN_MARGIN)) {
    return { chosen: first, decision: "auto", rule: "clear_leader" };
  }
  return { decision: "queued", rule: "weak_match" };
}
