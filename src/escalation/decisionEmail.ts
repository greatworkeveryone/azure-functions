// The emails about a decision request (jobs plan A1). They are the escalation
// engine's own events (raised, reminded, moved up, told to the level it left),
// worded for what this is: someone asking people for a decision. A generic
// escalation email says "Something needs your attention" and, to the level a row
// has left, "You don't need to do anything"; both would mislead here. Pure: the
// notifier hands in the row, the link and the names of the people asked.
//
// An email is a pointer into Floorplan with a link, never the place a decision is
// made, and it never carries more than the question and the job it is about.

import { formatDarwinDateTime } from "../ledger/darwinTime";
import { decisionOf } from "./decisionRows";
import type { NotifyEvent } from "./notifier";
import { roleLabel } from "./roles";
import type { EscalationRow } from "./types";

export type DecisionEmailKind = NotifyEvent | "fyi" | "resolved";

const QUESTION_IN_EMAIL_MAX = 1500;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

function headline(kind: DecisionEmailKind, row: EscalationRow, emergency: boolean): string {
  const raiser = row.raisedByKind === "system" ? "Floorplan" : row.raisedByName;
  switch (kind) {
    case "raise":
      return emergency
        ? `This is an emergency. ${raiser} has raised it and needs you to call them now. Floorplan will not chase it.`
        : `${raiser} has asked for a decision in Floorplan.`;
    case "reminder":
    case "follow_up":
      return "A decision is still waiting for you.";
    case "supersede":
      return "A decision was not made by the time it was due, so it has been escalated to you. You may need to chase the people it was asked of.";
    case "fyi":
      return `This decision is overdue and has been escalated to ${roleLabel(row.targetRole)}. It still needs your decision.`;
    case "resolved":
      return "This decision request has been closed.";
  }
}

function subjectPrefix(kind: DecisionEmailKind, row: EscalationRow, emergency: boolean): string {
  switch (kind) {
    case "raise":
      return emergency ? "EMERGENCY decision needed" : row.urgent ? "URGENT decision needed" : "Decision needed";
    case "reminder":
    case "follow_up":
      return "Reminder, decision needed";
    case "supersede":
      return row.urgent ? "URGENT decision overdue, escalated to you" : "Decision overdue, escalated to you";
    case "fyi":
      return "FYI, decision escalated";
    case "resolved":
      return "Decision closed";
  }
}

/**
 * Subject and body of an email about a decision request, or null when the row is
 * not one (or its context is not what a request writes), in which case the generic
 * escalation email is used. `askedOf` is the names of the people it was asked of.
 */
export function buildDecisionEmail(
  kind: DecisionEmailKind,
  row: EscalationRow,
  link: string | null,
  askedOf: readonly string[],
): { body: string; subject: string } | null {
  const decision = decisionOf(row);
  if (!decision) return null;

  const label = decision.jobLabel ?? row.summary;
  const lines = ["Hi,", "", headline(kind, row, decision.callThem), "", `Question: ${clip(decision.question, QUESTION_IN_EMAIL_MAX)}`, `Job: ${label}`];
  if (askedOf.length > 0) lines.push(`Asked of: ${askedOf.join(", ")}`);
  lines.push(`Raised by: ${row.raisedByKind === "system" ? "Floorplan (automatic)" : row.raisedByName}`);
  if (kind !== "resolved" && decision.respondBy) lines.push(`Respond by: ${formatDarwinDateTime(decision.respondBy)} Darwin time`);
  lines.push("", link ? `Open it in Floorplan: ${link}` : "Open Floorplan to see it.");
  lines.push("", "This email only points you to Floorplan. Decisions are made there, not by replying.");

  return {
    body: `${lines.join("\n")}\n`,
    subject: `${subjectPrefix(kind, row, decision.callThem)}: ${label}`.slice(0, 250),
  };
}
