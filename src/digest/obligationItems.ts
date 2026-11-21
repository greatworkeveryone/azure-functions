// The digest's lines for approvals, escalations, jobs and the rest: the same obligations the in-app inbox lists,
// from the same read, so the email and My work agree on what is waiting. Only what waits on the person (decide and
// do) is a line; what they are waiting on others for is not a reason to email them. A line never carries an amount.

import { deriveObligations, makeViewer, type LoadedObligationsLike } from "../obligations";
import type { DigestItem, DigestUser } from "./types";

const LINE_MAX = 140;
const ORDER_FIRST = { decide: 0, do: 1e14 } as const;

const clip = (text: string): string => (text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 3)}...` : text);

export function obligationItems(user: DigestUser, loaded: LoadedObligationsLike): DigestItem[] {
  const viewer = makeViewer({ email: user.email, name: user.name, oid: user.entraOid ?? null, roles: [user.role], userId: user.userId });
  const { items } = deriveObligations(loaded.sources, viewer, loaded.context, loaded.unavailable, Number.MAX_SAFE_INTEGER);
  return items
    .filter((item) => item.group !== "waiting")
    .map((item): DigestItem => ({
      dedupeKey: item.id,
      kind: item.kind === "escalation" ? "escalation" : item.group === "decide" ? "approval" : "due",
      line: clip(`${item.verb}: ${item.subject}`),
      order: ORDER_FIRST[item.group as "decide" | "do"] + (item.waitingSince ? new Date(item.waitingSince).getTime() : 0),
      path: item.link,
    }));
}
