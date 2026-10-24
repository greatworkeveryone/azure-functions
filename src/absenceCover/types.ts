// Shared shapes for cover while away (PLAN §13, AW1). Pure types and constants.
//
// Vocabulary: a person is ABSENT for one reason (leave they booked ahead, leave
// that was not planned, or no sign-in for a while); each piece of their
// outstanding work is an ITEM with a due date and an importance; the POLICY says
// whether an item moves at once or is only suggested to a manager; the COVER is
// who it moves to. Nothing here approves anything: a move changes who has the item.

import type { Capability } from "../action-roles";
import type { DirectoryUser } from "../escalation/types";

export type AbsenceKind = "planned" | "unplanned" | "inactive";

export const ITEM_TYPES = ["job", "decision_request", "escalation", "approval", "email", "leave_approval"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export type Importance = "high" | "medium" | "low";

/** What the ledger records. `kept` is a manager leaving a suggested item where it is. */
export const COVER_ACTIONS = ["reassigned", "escalated", "suggested", "kept", "taken_back"] as const;
export type CoverActionKind = (typeof COVER_ACTIONS)[number];

/** Where a cover came from, in the order they are tried. */
export type CoverSource = "delegate" | "reporting_manager" | "team_manager" | "ladder";

export interface AbsentPerson {
  /** The end of the leave, running on through leave booked straight after it. Null when inactive. */
  endDate: string | null;
  kind: AbsenceKind;
  /** Last day (Darwin) they were seen signing in, when logging has seen them. */
  lastSeenOn: string | null;
  leaveKind: string | null;
  leaveRequestId: number | null;
  name: string;
  /** Completed business days with no sign-in; only for `inactive`. */
  quietBusinessDays: number | null;
  /** One plain sentence for the screen, e.g. "On leave until 30/10/2026". It never says what kind of leave: it is also written to the permanent ledger. */
  reason: string;
  reasonCode: "no_sign_in" | "planned_leave" | "unplanned_leave";
  /** Names the absence so a manager's "keep" holds for it and no other. */
  ref: string;
  /** The first business day back: the next one after the leave ends. Null when unknown. */
  returnDate: string | null;
  role: string;
  startDate: string | null;
  userId: number;
}

/** What the cover must be able to do for an item. */
export interface MoneyNeed {
  amount: number | null;
  buildingId: number;
  createdByName: string | null;
  subject: "quote";
}

/** How a move is carried out. `none`: listed for a manager, cannot be moved from here yet. */
export type MoveKind = "escalation_retarget" | "decision_makers" | "job_assignee" | "email_assignee" | "notice" | "none";

export interface CoverItem {
  /** Set for items only the owner can answer (a manager asked "did you agree?"): left with them. */
  personal: boolean;
  /** The action-roles capability the cover must hold; null when `minRole` or `money` decides. */
  capability: Capability | null;
  deepLink: string;
  /** The ids a move needs, per item type (an escalation's row version, a job's name). */
  detail: Record<string, number | string | null>;
  dueAt: Date | null;
  id: string;
  importance: Importance;
  /** Why it is that important, as a code: priority, tier, money, lease_deadline, escalation_level, urgent, default. */
  importanceCode: string;
  isTest: boolean;
  /** One line naming the item: "Job #12 · Leaking roof · Tower A". */
  label: string;
  /** An authority escalation's target role: a cover must hold it or sit above it. */
  minRole: string | null;
  money: MoneyNeed | null;
  move: MoveKind;
  ownerUserId: number;
  /** Extra rule on who may cover (leave approvals: someone the leave rules accept as an approver). */
  onlyIf?: (person: DirectoryUser) => boolean;
  /** Whoever raised or asked for it: never its cover (separation of duties). */
  raisedByUserId: number | null;
  type: ItemType;
}

export type MoveDecision =
  | { action: "move"; reasonCode: "due_before_return" | "urgent_inactive" | "urgent_unplanned" }
  | { action: "stay"; reasonCode: "personal" }
  | { action: "suggest"; reasonCode: "back_in_time" | "due_after_return" | "inactive_not_urgent" | "no_due_date" };

export interface CoverDelegate {
  coverDelegateId: number;
  delegateUserId: number;
  fromDate: string;
  leaveRequestId: number | null;
  toDate: string;
  userId: number;
}

export interface ReportingLink {
  managerId: number;
  userId: number;
}

/** Everything the cover choice reads, loaded once per run. */
export interface CoverContext {
  /** Everyone away today, whatever the reason: never a cover. */
  absentIds: ReadonlySet<number>;
  delegates: readonly CoverDelegate[];
  directory: readonly DirectoryUser[];
  links: readonly ReportingLink[];
  /** For money items. */
  moneyFacts: import("../approvalAuthority").AuthorityFacts | null;
  today: string;
}

export interface SkippedCover {
  /** Who was passed over: their name, or a placeholder for someone no longer in the directory. */
  name: string;
  reason: string;
  source: CoverSource;
  userId: number | null;
}

export type CoverResolution =
  | {
      action: "escalated" | "reassigned";
      found: true;
      name: string;
      role: string;
      skipped: SkippedCover[];
      source: CoverSource;
      userId: number;
    }
  | { found: false; skipped: SkippedCover[] };

export const IMPORTANCE_RANK: Record<Importance, number> = { high: 3, low: 1, medium: 2 };

/** The system's name in a ledger row and a job's history. */
export const COVER_ACTOR_NAME = "Floorplan (cover while away)";
