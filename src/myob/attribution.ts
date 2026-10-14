// Who did it, written into the record itself (decision 13): MYOB's own audit
// log names the integration user, so every record Floorplan creates carries
// the humans in JournalMemo and Comment:
//   FP {reference} · proposed {name} {dd/mm hh:mm} · approved {name} {dd/mm hh:mm}
// and the Comment adds the proposal number and the Floorplan link. Both are
// held to MYOB_TEXT_MAX; names are shortened before anything is cut.

import { darwinStamp } from "./darwinClock";

/** JournalMemo and Comment limit. 255 is MYOB's documented memo limit; verify Comment in the lab. */
export const MYOB_TEXT_MAX = 255;
const NAME_MAX = 24;

export interface Attribution {
  approvedAt?: Date | null;
  approvedBy?: string | null;
  link?: string | null;
  proposalId?: number | null;
  proposedAt: Date;
  proposedBy: string;
  reference: string;
}

function memoWith(a: Attribution, shorten: (name: string) => string): string {
  const parts = [`FP ${a.reference}`, `proposed ${shorten(a.proposedBy)} ${darwinStamp(a.proposedAt)}`];
  if (a.approvedBy && a.approvedAt) parts.push(`approved ${shorten(a.approvedBy)} ${darwinStamp(a.approvedAt)}`);
  return parts.join(" · ");
}

function fit(text: string): string {
  return text.length <= MYOB_TEXT_MAX ? text : `${text.slice(0, MYOB_TEXT_MAX - 1)}…`;
}

const clean = (name: string) => name.replace(/\s+/g, " ").trim();
const short = (name: string) => (clean(name).length > NAME_MAX ? `${clean(name).slice(0, NAME_MAX - 1)}…` : clean(name));

export function journalMemo(a: Attribution): string {
  const full = memoWith(a, clean);
  return fit(full.length <= MYOB_TEXT_MAX ? full : memoWith(a, short));
}

export function orderComment(a: Attribution): string {
  const memo = journalMemo(a);
  const extras = [a.proposalId ? `proposal #${a.proposalId}` : null, a.link ?? null].filter(Boolean);
  const withAll = [memo, ...extras].join(" · ");
  if (withAll.length <= MYOB_TEXT_MAX) return withAll;
  const withoutLink = [memo, ...extras.slice(0, 1)].join(" · ");
  return fit(withoutLink);
}
