// How each kind of item changes hands. The mover for a type is the one place that
// writes it, through that domain's own columns and history, never a bare UPDATE of
// status or approval state (a reassignment is not a transition, and an approval is
// never given). Types with no mover can be listed and suggested, not moved from here.

import type { ItemType, MoveKind } from "../types";
import { moveDecision } from "./moveDecision";
import { moveEmail } from "./moveEmail";
import { moveEscalation } from "./moveEscalation";
import { moveJob } from "./moveJob";
import type { Mover } from "./types";

export const MOVERS: Partial<Record<MoveKind, Mover>> = {
  decision_makers: moveDecision,
  email_assignee: moveEmail,
  escalation_retarget: moveEscalation,
  job_assignee: moveJob,
};

/** A move that changes who holds the item can be handed back; a notice only told someone. */
export const canTakeBack = (kind: MoveKind): boolean => MOVERS[kind] !== undefined;

/** Whether the engine can carry the move out itself. */
export const isMovable = (kind: MoveKind): boolean => kind === "notice" || MOVERS[kind] !== undefined;

export const MOVE_KIND_OF: Record<ItemType, MoveKind> = {
  approval: "notice",
  decision_request: "decision_makers",
  email: "email_assignee",
  escalation: "escalation_retarget",
  job: "job_assignee",
  leave_approval: "none",
};
