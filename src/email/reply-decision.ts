// Does a director's reply actually say the decision the operator is recording?
// Only the director's own words count: quoted lines and anything below a
// quote header are dropped before matching.

export type ReplyDecision = "approved" | "rejected";

export type ReplyDecisionCheck =
  | { ok: true }
  | { ok: false; reason: "no_decision" | "ambiguous" };

const QUOTE_HEADER = /^(from:|sent:|-{2,}\s*original message|on .+ wrote:?$|_{5,})/i;

// Multi-word phrases first so "do not proceed" is consumed before "proceed" is seen.
const REJECT = /\b(do not proceed|don'?t proceed|not approved|rejected|reject|declined|decline|no)\b/gi;
const APPROVE = /\b(ok to proceed|go ahead|approved|approve|proceed|yes)\b/gi;

/** The director's own text: quoted lines and everything under a quote header removed. */
export function ownWords(body: string | null | undefined): string {
  if (!body) return "";
  const kept: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (QUOTE_HEADER.test(line)) break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function replyStatesDecision(body: string | null | undefined, decision: ReplyDecision): ReplyDecisionCheck {
  const text = ownWords(body);
  const rejects = text.match(REJECT) ?? [];
  // Strip rejection phrases so their inner words ("proceed") can't read as approval.
  const approves = text.replace(REJECT, " ").match(APPROVE) ?? [];
  const saysApprove = approves.length > 0;
  const saysReject = rejects.length > 0;
  if (saysApprove && saysReject) return { ok: false, reason: "ambiguous" };
  if (decision === "approved" ? saysApprove : saysReject) return { ok: true };
  return { ok: false, reason: "no_decision" };
}

export function replyDecisionMessage(decision: ReplyDecision, reason: "no_decision" | "ambiguous"): string {
  const word = decision === "approved" ? "approval" : "rejection";
  return reason === "ambiguous"
    ? `The director's reply contains both approval and rejection wording, so it can't be recorded as ${decision} — ask the director to confirm in-app`
    : `The director's reply does not clearly state ${word} — ask the director to reply with a clear decision or approve in-app`;
}
