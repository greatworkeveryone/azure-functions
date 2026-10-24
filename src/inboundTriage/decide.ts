// Inbound email triage (EB3): assign automatically, or ask a manager. Pure. The rule is
// deliberately narrow, because a wrong automatic assignment sends someone's mail to the wrong
// desk and a queue entry costs a manager one tap.
//
// Never automatic for a sender Exchange could not verify, or (see replyVerified) for a reply link whose email
// did not come from the address the send went to. Otherwise, automatic only when:
// - the email replies to a send, and the person who sent it is eligible (not away, not inactive):
//   they began the conversation, so it comes back to them; or
// - one person leads: their score reaches AUTO_MIN_SCORE, and they are ahead of the next by at
//   least AUTO_MIN_MARGIN (or nobody else is a candidate).
// Anything else goes to the manager's "Needs triage" queue with the top three.

import type { ScoredCandidate, TriageContext } from "./types";

export const AUTO_MIN_SCORE = 40;
export const AUTO_MIN_MARGIN = 15;
export const QUEUE_SUGGESTIONS = 3;

export type QueueRule = "no_candidates" | "reply_unverified" | "sender_unverified" | "weak_match";

export type AutoRule = "reply_to_known_send" | "clear_leader";

export type Verdict = { chosen: ScoredCandidate; decision: "auto"; rule: AutoRule } | { decision: "queued"; rule: QueueRule };

export function decide(ranked: readonly ScoredCandidate[], context: TriageContext): Verdict {
  // Exchange could not verify who wrote it: whoever it says it is, a person decides (M4 of the 24 Oct security review).
  if (!context.senderVerified) return { decision: "queued", rule: "sender_unverified" };
  if (ranked.length === 0) return { decision: "queued", rule: "no_candidates" };

  const senderId = context.linkedSend?.sentByUserId ?? null;
  const sender = senderId === null ? undefined : ranked.find((candidate) => candidate.userId === senderId);
  // A reply link alone proves nothing about who is writing (a forwarded notice carries its Message-ID), so it
  // only assigns when the email came from the address the send went to, from a verified sender.
  if (sender) {
    return context.replyVerified ? { chosen: sender, decision: "auto", rule: "reply_to_known_send" } : { decision: "queued", rule: "reply_unverified" };
  }

  const [first, second] = ranked;
  if (first.score >= AUTO_MIN_SCORE && (!second || first.score - second.score >= AUTO_MIN_MARGIN)) {
    return { chosen: first, decision: "auto", rule: "clear_leader" };
  }
  return { decision: "queued", rule: "weak_match" };
}
