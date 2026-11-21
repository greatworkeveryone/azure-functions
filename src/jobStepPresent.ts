// What one person sees of a job's next action: a button they can press, or a plain wait that names who can act.
// Byte-identical in both repos with jobStepResolver.ts. Pure: the viewer's capabilities come in as a function.
//
// The server's answer (jobStepResolver) does not depend on who is looking. This does: "Waiting on you" is true only
// when the viewer is the assignee or the named approver or, for a job nobody owns, holds the capability the step needs.
// A viewer without that capability never gets a disabled button: they get a wait that says who can act.

import type { NextAction, StepActor, StepJumpTarget, StepDirectAction } from "./jobStepTypes";

export interface StepViewer {
  /** Whether the viewer holds an action-roles capability (useCan on the screen, the role table in tests). */
  can: (capability: string) => boolean;
  name: string | null;
  oid: string | null;
  userId: number | null;
}

export interface PresentedAction {
  action: StepDirectAction | null;
  capability: string | null;
  /** The reason printed beside the control. */
  detail: string;
  /** Primary is the one contained button on the screen; secondary is outlined (it is someone else's turn first). */
  emphasis: "primary" | "secondary";
  isPassive: boolean;
  jumpTarget: StepJumpTarget | null;
  /** The button text, or the whole sentence of a passive wait. */
  label: string;
  /** "Waiting on you" is true. */
  onViewer: boolean;
  /** The short line for a pill or a row: "Waiting on Terry", "Waiting on Facilities · unassigned", "Waiting on you". */
  waitLine: string;
}

const sameText = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whoever added a record does not approve it; a director is never blocked by that (the server's creatorRefusal). */
function addedByViewer(creator: StepActor | null, viewer: StepViewer): boolean {
  if (!creator || viewer.can("approveQuoteAsDirector")) return false;
  if (creator.oid && viewer.oid) return creator.oid.trim().toLowerCase() === viewer.oid.trim().toLowerCase();
  return sameText(creator.name, viewer.name);
}

function isViewerTurn(next: NextAction, viewer: StepViewer): boolean {
  // A job nobody owns is waiting on a team, not on one person: "Waiting on Facilities · unassigned".
  if (next.unassigned) return false;
  if (next.waitingOnUserId !== null) return next.waitingOnUserId === viewer.userId;
  // A named assignee with no user id on record (older jobs): match by name. A team is everyone who holds the capability.
  return next.person ? sameText(next.who, viewer.name) : true;
}

function waitLineOf(next: NextAction, onViewer: boolean): string {
  if (next.action === "downloadPacket") return "Closed";
  if (next.action === "unblock") return "On hold";
  if (onViewer) return "Waiting on you";
  if (next.externalWait) return `Waiting on ${next.externalWait}`;
  return `Waiting on ${next.who}${next.unassigned ? " · unassigned" : ""}`;
}

export function presentNextAction(next: NextAction, viewer: StepViewer): PresentedAction {
  const base = { action: next.action, capability: next.capability, detail: next.reason, jumpTarget: next.jumpTarget };
  const holds = next.capability === null || viewer.can(next.capability);

  if (holds && addedByViewer(next.creator, viewer)) {
    return {
      ...base,
      emphasis: "secondary",
      isPassive: true,
      label: "Waiting on another approver (you added this)",
      onViewer: false,
      waitLine: `Waiting on ${next.who}`,
    };
  }

  if (!holds && next.escalation && viewer.can(next.escalation.capability)) {
    return {
      ...base,
      detail: next.escalation.reason,
      emphasis: "primary",
      isPassive: false,
      jumpTarget: next.escalation.jumpTarget,
      label: next.escalation.verb,
      onViewer: true,
      waitLine: "Waiting on you",
    };
  }

  if (!holds) {
    const subject = next.externalWait ? `${next.externalWait} to reply` : `${next.who}${next.unassigned ? " (unassigned)" : ""} to ${next.task}`;
    return {
      ...base,
      emphasis: "secondary",
      isPassive: true,
      label: `Waiting on ${subject}`,
      onViewer: false,
      waitLine: waitLineOf(next, false),
    };
  }

  const onViewer = next.externalWait === null && isViewerTurn(next, viewer);
  return {
    ...base,
    emphasis: onViewer || next.capability === null || next.unassigned ? "primary" : "secondary",
    isPassive: false,
    label: next.verb,
    onViewer: onViewer && next.action !== "downloadPacket",
    waitLine: waitLineOf(next, onViewer && next.action !== "downloadPacket"),
  };
}
