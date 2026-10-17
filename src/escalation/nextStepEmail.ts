// The emails about a next step (jobs plan A2): the step a decision hands to a person
// or a role. They are the escalation engine's own events (raised, reminded, moved
// up, told to the level it left), worded for what this is: someone has decided and
// handed you what happens next. A generic escalation email says "Something needs
// your attention" and, to the level a row has left, "You don't need to do anything";
// neither would help here. Pure: the notifier hands in the row, the link and the
// names of the people it was handed to.
//
// An email is a pointer into Floorplan with a link; the step is marked done there,
// not by replying. It carries what the owner needs to start (the outcome, the
// rationale, the step and when it is due) and no more.

import { formatDarwinDateTime } from "../ledger/darwinTime";
import type { DecisionEmailKind } from "./decisionEmail";
import { nextStepOf, type NextStepNote } from "./decisionRows";
import { roleLabel } from "./roles";
import type { EscalationRow } from "./types";

const RATIONALE_IN_EMAIL_MAX = 600;
const STEP_IN_EMAIL_MAX = 1000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/** "Approved", "Denied", "Deferred", "Revisions requested". */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "approve":
      return "Approved";
    case "deny":
      return "Denied";
    case "defer":
      return "Deferred";
    case "revise":
      return "Revisions requested";
    default:
      return "Decided";
  }
}

function headline(kind: DecisionEmailKind, row: EscalationRow, step: NextStepNote, ownedBy: readonly string[]): string {
  const who = step.respondedBy || "A decision-maker";
  switch (kind) {
    case "raise":
      if (step.outcome === "revise") return `${who} has asked for changes and passed the job back for the next step.`;
      return step.ownerRole && !step.ownerUserId
        ? `${who} has decided on a job and handed the next step to the ${roleLabel(step.ownerRole)} role.`
        : `${who} has decided on a job and handed the next step to you.`;
    case "reminder":
    case "follow_up":
      return "A next step is still waiting for you.";
    case "supersede":
      return `A next step was not done by the time it was due, so it has been escalated to you.${ownedBy.length > 0 ? ` You may need to chase ${ownedBy.join(", ")}.` : ""}`;
    case "fyi":
      return `This next step is overdue and has been escalated to ${roleLabel(row.targetRole)}. It still needs doing.`;
    case "resolved":
      return "This next step is done.";
  }
}

function subjectPrefix(kind: DecisionEmailKind, row: EscalationRow, step: NextStepNote): string {
  switch (kind) {
    case "raise":
      if (step.outcome === "revise") return "Revisions requested";
      return row.urgent ? "URGENT next step for you" : "Next step for you";
    case "reminder":
    case "follow_up":
      return "Reminder, next step due";
    case "supersede":
      return row.urgent ? "URGENT next step overdue, escalated to you" : "Next step overdue, escalated to you";
    case "fyi":
      return "FYI, next step escalated";
    case "resolved":
      return "Next step done";
  }
}

/**
 * Subject and body of an email about a next step, or null when the row is not one
 * (or its context is not what a decision writes), in which case the generic
 * escalation email is used. `ownedBy` is the names of the people it was handed to.
 */
export function buildNextStepEmail(
  kind: DecisionEmailKind,
  row: EscalationRow,
  link: string | null,
  ownedBy: readonly string[] = [],
): { body: string; subject: string } | null {
  const step = nextStepOf(row);
  if (!step) return null;

  const label = step.jobLabel ?? row.summary;
  const lines = ["Hi,", "", headline(kind, row, step, ownedBy), ""];
  lines.push(`Decision: ${outcomeLabel(step.outcome)}${step.respondedBy ? ` by ${step.respondedBy}` : ""}`);
  if (step.rationale) lines.push(`Why: ${clip(step.rationale, RATIONALE_IN_EMAIL_MAX)}`);
  lines.push(`Next step: ${clip(step.nextStep, STEP_IN_EMAIL_MAX)}`, `Job: ${label}`);
  if (ownedBy.length > 0 && kind !== "raise") lines.push(`With: ${ownedBy.join(", ")}`);
  if (kind !== "resolved" && step.dueAt) lines.push(`Due: ${formatDarwinDateTime(step.dueAt)} Darwin time`);
  lines.push("", link ? `Open it in Floorplan: ${link}` : "Open Floorplan to see it.");
  lines.push("", "This email only points you to Floorplan. Mark the step done there, not by replying.");

  return {
    body: `${lines.join("\n")}\n`,
    subject: `${subjectPrefix(kind, row, step)}: ${label}`.slice(0, 250),
  };
}
