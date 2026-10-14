// What needs a person this morning, as pure rules over the facts the digest
// read (N1). The frontend derives the dashboard's activity feed in
// src/hooks/activityFeedDerivation.ts; the rules this digest needs are ported
// here rather than called. A line never carries an amount.
//
//   escalations   open ones that target the person (the notifier's own targeting)
//   approvals     a quote or an incoming invoice the person may approve, by the
//                 approval-authority rules (SUBJECT_ELIGIBLE_ROLES, limits and the
//                 director threshold); admin is never asked (decision 4)
//   due           a live job assigned to them whose next-update date is today or past
//   keys          keys still out past their expected return, for facilities roles
//
// Not here yet:
//   purchase orders  no approval status exists on dbo.PurchaseOrders at this base.
//   tenancies        "not signed off, for accounts managers" needs the schedule
//                    sign-off column (PLAN WP24, migration 097, lane U2), which is
//                    not at this base.
//   inspections      "awaiting jobs" needs U9.
// A job that is escalated, awaiting approval and due is one line, the best of them.

import { canApprove, decideAuthority, type AuthorityFacts } from "../approvalAuthority";
import { darwinDateKey } from "../escalation/businessTime";
import { targetUsers } from "../escalation/notifier";
import type { DirectoryUser } from "../escalation/types";
import { DIGEST_MAX_LINES } from "./config";
import { clip, formatDisplayDate } from "./format";
import type { DigestFacts, DigestItem, DigestItemKind, DigestUser, DueJob, OverdueKey, WaitingApproval } from "./types";

export interface DeriveContext {
  /** The approval-authority facts for a building (limits, threshold). */
  authorityFacts(buildingId: number | null): AuthorityFacts;
  now: Date;
}

const LINE_MAX = 140;
const TITLE_MAX = 80;
const BUILDING_MAX = 40;
const FACILITIES_ROLES: ReadonlySet<string> = new Set(["facilities", "facilities_manager"]);
const URGENT_FIRST = 1e14;

const KIND_RANK: Record<DigestItemKind, number> = { approval: 1, due: 2, escalation: 0, key: 3 };

const jobPath = (jobId: number | string): string => `/jobs?jobId=${encodeURIComponent(String(jobId))}`;

function jobLabel(jobId: number, title: string, buildingName: string | null): string {
  const building = buildingName ? ` · ${clip(buildingName, BUILDING_MAX)}` : "";
  return `Job #${jobId} · ${clip(title, TITLE_MAX)}${building}`;
}

// ── Escalations ──────────────────────────────────────────────────────────────

function escalationItems(user: DigestUser, facts: DigestFacts): DigestItem[] {
  const directory: DirectoryUser[] = facts.users.map((u) => ({ email: u.email, name: u.name, role: u.role, userId: u.userId }));
  const items: DigestItem[] = [];
  for (const row of facts.escalations) {
    // An acknowledged escalation has been picked up; only the unanswered ones nag.
    if (row.status !== "open") continue;
    if (!targetUsers(row, directory).some((target) => target.userId === user.userId)) continue;
    const isJob = row.subjectType === "job";
    items.push({
      dedupeKey: isJob ? `job:${row.subjectId}` : `escalation:${row.escalationId}`,
      kind: "escalation",
      line: clip(`${row.urgent ? "Urgent: " : ""}${row.summary}`, LINE_MAX),
      order: (row.urgent ? 0 : URGENT_FIRST) + row.createdAt.getTime(),
      path: isJob ? jobPath(row.subjectId) : "/escalations",
    });
  }
  return items;
}

// ── Approvals ────────────────────────────────────────────────────────────────

/** Whose move it is: the first approver (anyone with authority for the amount) or the director. */
function approvalStage(approval: WaitingApproval, facts: AuthorityFacts, amount: number): "director" | "first" | null {
  if (approval.status === "pending") return "first";
  if (approval.subject === "quote") return approval.status === "awaiting_director" ? "director" : null;
  if (approval.status !== "approved") return null;
  // A stage-1 approved invoice only waits for someone when its amount needs the director.
  const route = decideAuthority({ amount, buildingId: approval.buildingId ?? 0, jobId: approval.jobId, subject: "invoice" }, facts);
  return route.directorRequired ? "director" : null;
}

function mayApprove(user: DigestUser, approval: WaitingApproval, ctx: DeriveContext): boolean {
  if (user.role === "admin") return false;
  const facts = ctx.authorityFacts(approval.buildingId);
  // An unknown amount is NaN, which the rules treat as "needs the director".
  const amount = approval.amount === null ? Number.NaN : approval.amount;
  const stage = approvalStage(approval, facts, amount);
  if (stage === null) return false;
  if (stage === "director") return user.role === "director";
  const identity = { email: user.email ?? undefined, roles: [user.role], userId: user.userId };
  const input = { amount, buildingId: approval.buildingId ?? 0, jobId: approval.jobId, subject: approval.subject };
  return canApprove(identity, input, facts).allowed;
}

function approvalItems(user: DigestUser, facts: DigestFacts, ctx: DeriveContext): DigestItem[] {
  return facts.waitingApprovals
    .filter((approval) => mayApprove(user, approval, ctx))
    .map((approval) => ({
      dedupeKey: `job:${approval.jobId}`,
      kind: "approval" as const,
      line: `Approve ${approval.subject}: ${jobLabel(approval.jobId, approval.jobTitle, approval.buildingName)}`,
      order: approval.createdAt.getTime(),
      path: jobPath(approval.jobId),
    }));
}

// ── Due today or overdue ─────────────────────────────────────────────────────

function dueItem(job: DueJob, todayKey: string): DigestItem | null {
  const dueKey = darwinDateKey(job.expectedProgressUpdate);
  if (dueKey > todayKey) return null;
  const when = dueKey === todayKey ? "update due today" : `update was due ${formatDisplayDate(dueKey)}`;
  return {
    dedupeKey: `job:${job.jobId}`,
    kind: "due",
    line: `${jobLabel(job.jobId, job.title, job.buildingName)}: ${when}`,
    order: job.expectedProgressUpdate.getTime(),
    path: jobPath(job.jobId),
  };
}

function dueItems(user: DigestUser, facts: DigestFacts, ctx: DeriveContext): DigestItem[] {
  const todayKey = darwinDateKey(ctx.now);
  const items: DigestItem[] = [];
  for (const job of facts.dueJobs) {
    if (job.assignedToUserId !== user.userId) continue;
    const item = dueItem(job, todayKey);
    if (item) items.push(item);
  }
  return items;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

function keyLine(keys: OverdueKey[]): string {
  const [first] = keys;
  const buildings = new Set(keys.map((k) => k.buildingName));
  const at = buildings.size === 1 && first.buildingName ? ` at ${clip(first.buildingName, BUILDING_MAX)}` : "";
  const due = formatDisplayDate(darwinDateKey(first.expectedReturnAt));
  if (keys.length === 1) return `Key ${first.keyNumber}${at} was due back ${due}`;
  return `Keys ${first.keyNumber} and ${keys.length - 1} more${at} were due back ${due}`;
}

function keyItems(user: DigestUser, facts: DigestFacts): DigestItem[] {
  if (!FACILITIES_ROLES.has(user.role)) return [];
  // One line per checkout, not per key: eight keys taken together are one reminder.
  const batches = new Map<number, OverdueKey[]>();
  for (const key of facts.overdueKeys) batches.set(key.batchId, [...(batches.get(key.batchId) ?? []), key]);
  return [...batches.entries()].map(([batchId, keys]) => {
    const sorted = [...keys].sort((a, b) => a.keyId - b.keyId);
    return {
      dedupeKey: `keys:${batchId}`,
      kind: "key" as const,
      line: keyLine(sorted),
      order: sorted[0].expectedReturnAt.getTime(),
      path: `/keys/${sorted[0].keyId}`,
    };
  });
}

// ── Putting it together ──────────────────────────────────────────────────────

function compareItems(a: DigestItem, b: DigestItem): number {
  return KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.order - b.order || a.line.localeCompare(b.line);
}

/** Everything that needs this person, best first, with each job or checkout once. */
export function deriveItems(user: DigestUser, facts: DigestFacts, ctx: DeriveContext): DigestItem[] {
  const all = [...escalationItems(user, facts), ...approvalItems(user, facts, ctx), ...dueItems(user, facts, ctx), ...keyItems(user, facts)];
  const best = new Map<string, DigestItem>();
  for (const item of all) {
    const kept = best.get(item.dedupeKey);
    if (!kept || compareItems(item, kept) < 0) best.set(item.dedupeKey, item);
  }
  return [...best.values()].sort(compareItems);
}

/** The lines to show and how many are left over for "and N more". */
export function pickLines(items: readonly DigestItem[], max: number = DIGEST_MAX_LINES): { more: number; shown: DigestItem[] } {
  return { more: Math.max(0, items.length - max), shown: items.slice(0, max) };
}
