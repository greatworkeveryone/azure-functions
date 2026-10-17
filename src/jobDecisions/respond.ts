// Reading an answer to a decision request, and the rules about its date (jobs plan
// A2). Pure: no I/O. The endpoint turns the RequestError this throws into the
// response, exactly as for asking.
//
// POST /api/respondToJobDecision body:
//
//   requestId       the pending request being answered
//   rowVersion      the request's version as the screen last read it. Required: an
//                   answer to a question that has changed since is a 409
//   outcome         approve | deny | defer | revise
//   rationale       why, in words. Required, never blank, at most 2000 characters
//                   (the ledger's limit for a reason). It goes on the decision, the
//                   ledger, the job's history and, to the person who gets the step,
//                   their email
//   nextStep        what happens now, at most 2000 characters. Required for approve,
//                   deny and revise (revise: what to change); optional for defer
//   nextStepOwner   who does it: { userId: 9 } for a person, { role: "accounts" } for
//                   everyone in a role. Left out, it is the person who raised the job.
//                   Only with a nextStep
//   deferUntil      YYYY-MM-DD, a working day in Darwin after today. Defer only, and
//                   required for it: the question comes back to the same people that
//                   morning

import { addCalendarDays, darwinDateKey, isBusinessDay, isDateKey, type Holidays } from "../escalation/businessTime";
import { normaliseRole, roleLabel } from "../escalation/roles";
import { readId, RequestError } from "./request";
import { NEXT_STEP_OWNER_ROLES } from "./roles";
import { FIXED_MAX_DAYS_AHEAD } from "./tiers";

export const OUTCOMES = ["approve", "deny", "defer", "revise"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const RATIONALE_MAX_CHARS = 2000;
export const NEXT_STEP_MAX_CHARS = 2000;
/** The note on a step marked done: the column holds 1000 characters. */
export const STEP_NOTE_MAX_CHARS = 1000;

export const isOutcome = (value: unknown): value is Outcome => typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);

export type NextStepOwnerInput = { kind: "user"; userId: number } | { kind: "role"; role: string };

export interface ParsedResponse {
  /** YYYY-MM-DD; defer only. */
  deferUntil: string | null;
  nextStep: string | null;
  /** null: the person who raised the job. Never set without a nextStep. */
  nextStepOwner: NextStepOwnerInput | null;
  outcome: Outcome;
  rationale: string;
  requestId: number;
  rowVersion: string;
}

const bad = (message: string): RequestError => new RequestError("bad_request", message, 400);
const isBlank = (value: unknown): boolean => value === undefined || value === null || value === "";

/** A request version as the API sends it: base64 of the 8 bytes SQL Server keeps. */
export function readRowVersion(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw bad("rowVersion is required: send back the one you were given");
  const text = value.trim();
  if (text.length > 64 || Buffer.from(text, "base64").length !== 8) throw bad("rowVersion is not a valid version");
  return text;
}

function readOutcome(value: unknown): Outcome {
  if (!isOutcome(value)) {
    throw new RequestError("outcome_invalid", `outcome must be one of ${OUTCOMES.join(", ")}`, 400);
  }
  return value;
}

function readRationale(value: unknown): string {
  if (!isBlank(value) && typeof value !== "string") throw bad("rationale must be text");
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new RequestError("rationale_required", "Say why: every decision needs a rationale.", 400);
  if (text.length > RATIONALE_MAX_CHARS) throw bad(`The rationale can be at most ${RATIONALE_MAX_CHARS} characters`);
  return text;
}

function readNextStep(value: unknown): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== "string") throw bad("nextStep must be text");
  const text = value.trim();
  if (text.length > NEXT_STEP_MAX_CHARS) throw bad(`The next step can be at most ${NEXT_STEP_MAX_CHARS} characters`);
  return text === "" ? null : text;
}

function readOwner(value: unknown): NextStepOwnerInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw bad("nextStepOwner must be { userId } or { role }");
  const owner = value as Record<string, unknown>;
  const hasUser = !isBlank(owner.userId);
  const hasRole = !isBlank(owner.role);
  if (hasUser === hasRole) throw bad("nextStepOwner must name one person (userId) or one role (role)");
  if (hasUser) return { kind: "user", userId: readId(owner.userId, "nextStepOwner.userId") };
  if (typeof owner.role !== "string" || normaliseRole(owner.role) === "") throw bad("nextStepOwner.role must name a role");
  const role = normaliseRole(owner.role);
  if (!NEXT_STEP_OWNER_ROLES.includes(role)) {
    throw new RequestError(
      "next_step_owner_role_not_allowed",
      `${roleLabel(role)} can't open Floorplan's escalation inbox, so a step handed to that role would never be seen. Pick someone else.`,
      422,
      { role },
    );
  }
  return { kind: "role", role };
}

/** A request body -> the typed answer, or a RequestError. No I/O: the date is only
 *  checked for being a real one here; validateDeferUntil says whether it is a day to come. */
export function parseRespondBody(body: Record<string, unknown>): ParsedResponse {
  const outcome = readOutcome(body.outcome);
  const requestId = readId(body.requestId, "requestId");
  const rowVersion = readRowVersion(body.rowVersion);
  const rationale = readRationale(body.rationale);
  const nextStep = readNextStep(body.nextStep);
  const nextStepOwner = readOwner(body.nextStepOwner);

  if (outcome !== "defer" && nextStep === null) {
    throw new RequestError(
      "next_step_required",
      outcome === "revise"
        ? "Say what needs changing: a revision is a next step for the person it goes back to."
        : "Say what happens next: approving or denying hands the job to someone for a next step.",
      400,
    );
  }
  if (nextStep === null && nextStepOwner !== null) throw bad("nextStepOwner needs a nextStep: say what they are to do");

  let deferUntil: string | null = null;
  if (outcome === "defer") {
    if (isBlank(body.deferUntil)) {
      throw new RequestError("defer_until_required", "Say which day the question should come back (deferUntil, YYYY-MM-DD).", 400);
    }
    if (!isDateKey(body.deferUntil)) {
      throw new RequestError("defer_until_invalid", "deferUntil must be a real date written YYYY-MM-DD", 400);
    }
    deferUntil = body.deferUntil;
  } else if (!isBlank(body.deferUntil)) {
    throw new RequestError("unexpected_defer_until", `deferUntil only goes with defer, not ${outcome}`, 400);
  }

  return { deferUntil, nextStep, nextStepOwner, outcome, rationale, requestId, rowVersion };
}

/**
 * Whether a deferral's day is one the question can come back on: a working day in
 * Darwin after today, within a year (the same reach as a fixed deadline). Throws a
 * RequestError (422) saying which rule it breaks. Pure: pass the holidays.
 */
export function validateDeferUntil(deferUntil: string, now: Date, holidays: Holidays): void {
  const today = darwinDateKey(now);
  if (deferUntil <= today) {
    throw new RequestError("defer_until_past", "Pick a day after today: a deferred question comes back on a working day still to come.", 422);
  }
  if (!isBusinessDay(deferUntil, holidays)) {
    throw new RequestError(
      "defer_until_not_a_working_day",
      "That day is a weekend or a public holiday in Darwin. Pick the working day the question should come back.",
      422,
    );
  }
  if (deferUntil > addCalendarDays(today, FIXED_MAX_DAYS_AHEAD)) {
    throw new RequestError("defer_until_too_far", `Pick a day within the next ${FIXED_MAX_DAYS_AHEAD} days.`, 422);
  }
}

/** Whether a note on a step done is acceptable: optional, at most 1000 characters. */
export function readStepNote(value: unknown): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== "string") throw bad("note must be text");
  const text = value.trim();
  if (text.length > STEP_NOTE_MAX_CHARS) throw bad(`The note can be at most ${STEP_NOTE_MAX_CHARS} characters`);
  return text === "" ? null : text;
}
