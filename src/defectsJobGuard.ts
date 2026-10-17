// Defects periods on the job write path (LAUNCH-READINESS §5 behaviours 1-2;
// sprint F1). Called by upsertJob before a new job is inserted.
//
//   planned maintenance on a covered scope, block period  -> 409 with the
//       period(s): who is responsible and until when. A facilities manager,
//       director or admin may book it anyway by sending DefectsOverrideReason;
//       the job then gets a defects_override event and the ledger an exception.
//   anything else covered (reactive work, warn-only periods) -> created, with
//       the covering periods returned as warnings ("likely a defect").
//
// Only new jobs are checked: the rule is about booking work, and the scheduler
// skips covered schedules itself (F2).

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { requireRole } from "./auth";
import { executeQuery } from "./db";
import { displayDate, livePeriodsForBuilding, servicesLabel, type DefectsPeriodApi } from "./defectsPeriods";
import { DEFECTS_OVERRIDE_ROLES } from "./facilitiesRoles";
import { coveringPeriods, missingAnswer, type CoverageJob, type MissingAnswer } from "./facilitiesRules";
import { runsContractorFlow } from "./jobKinds";
import { record } from "./ledger";
import { Sentry } from "./sentry";
import { resolveLedgerActor } from "./ledger/actor";

export const DEFECTS_OVERRIDE_EVENT = "defects_override";
const REASON_MAX = 500;

export interface DefectsOverride {
  periods: DefectsPeriodApi[];
  reason: string;
}

export interface DefectsGuardResult {
  override: DefectsOverride | null;
  /** Set when the job must not be created: 400, 403 or 409. */
  response?: HttpResponseInit;
  /** Every live period covering the job (shown to the person as a warning). */
  warnings: DefectsPeriodApi[];
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function coverageFromFields(fields: Record<string, unknown>): CoverageJob | null {
  const buildingId = Number(fields.BuildingID);
  if (!Number.isInteger(buildingId) || buildingId === 0) return null;
  const tenantId = Number(fields.TenantID);
  return {
    buildingId,
    category: text(fields.Category),
    kind: text(fields.Kind) ?? "facilities",
    levelLocationId: null,
    levelName: text(fields.LevelName),
    tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : null,
    type: text(fields.Type),
  };
}

function scopeLabel(period: DefectsPeriodApi): string {
  if (period.scope === "level") return `on ${period.levelName ?? "that level"}`;
  if (period.scope === "tenancy") return `in ${period.tenantName ?? "that tenancy"}`;
  return "in this building";
}

/** "Choose the {answer} first: the {works} defects period covers part of this building …" */
export function missingAnswerMessage(period: DefectsPeriodApi, answer: MissingAnswer, canOverride: boolean): string {
  const next = canOverride ? "Book anyway with a reason if RP should do it." : "Ask a facilities manager if RP should book it anyway.";
  return `Choose the ${answer} first: the ${period.works} defects period covers part of this building until ${displayDate(period.endsOn)}, and Floorplan needs it to tell whether ${period.contractorName ?? "the builder"} owes this work. ${next}`;
}

/** "This is inside the {works} defects period until {date}: {who} is responsible for {services} {where}." */
export function blockedMessage(period: DefectsPeriodApi, canOverride: boolean): string {
  const who = `${period.contractorName ?? "The builder"}${period.contractorContact ? ` (${period.contractorContact})` : ""}`;
  const next = canOverride ? "Book anyway with a reason if RP should do it." : "Ask a facilities manager if RP should book it anyway.";
  return `This is inside the ${period.works} defects period until ${displayDate(period.endsOn)}: ${who} is responsible for ${servicesLabel(period.services)} ${scopeLabel(period)}. ${next}`;
}

// Migration 119 is applied by hand. If this code reaches an app whose database
// doesn't have the table yet, job creation must keep working: no table means no
// periods, said loudly to Sentry. Any other failure still fails the create.
const MISSING_TABLE = /Invalid object name 'dbo\.DefectsPeriods'/i;

async function livePeriodsOrNone(connection: Connection, buildingId: number, today: string): Promise<DefectsPeriodApi[]> {
  try {
    return await livePeriodsForBuilding(connection, buildingId, today);
  } catch (error) {
    if (!(error instanceof Error) || !MISSING_TABLE.test(error.message)) throw error;
    Sentry.captureMessage("dbo.DefectsPeriods is missing: apply migration 119. Jobs are created without the defects check.", "error");
    return [];
  }
}

export async function guardNewJob(
  connection: Connection,
  request: HttpRequest,
  body: Record<string, unknown>,
  fields: Record<string, unknown>,
  today: string,
): Promise<DefectsGuardResult> {
  const job = coverageFromFields(fields);
  // Defects liability is about contractor works, so only the kinds that run that
  // flow are checked: an Admin / Accounts job is never held, warned or overridden.
  if (!job || !runsContractorFlow(job.kind)) return { override: null, warnings: [] };
  const live = await livePeriodsOrNone(connection, job.buildingId, today);
  const covering = coveringPeriods(job, live, today);
  const blocking = covering.filter((period) => period.enforcement === "block");
  // A maintenance job that leaves out its category, level or tenant can't be
  // told apart from covered work, so it is held the same way (sprint F, UX C1).
  const unanswered =
    job.kind === "maintenance" && blocking.length === 0
      ? live.filter((period) => period.enforcement === "block" && missingAnswer(job, period, today) !== null)
      : [];
  if (job.kind !== "maintenance" || (blocking.length === 0 && unanswered.length === 0)) {
    // Reactive work never blocks. A manager's reason on covered reactive work
    // (say, after the form held a maintenance job switched to Facilities) is
    // still recorded, so the decision leaves a trail.
    const note = text(body.DefectsOverrideReason);
    if (note && note.length <= REASON_MAX && covering.length > 0 && (await requireRole(request, DEFECTS_OVERRIDE_ROLES)) === null) {
      return { override: { periods: covering, reason: note }, warnings: covering };
    }
    return { override: null, warnings: covering };
  }
  const held = blocking.length > 0 ? blocking : unanswered;

  const raw = body.DefectsOverrideReason;
  if (raw !== undefined && raw !== null && (typeof raw !== "string" || raw.trim().length > REASON_MAX)) {
    return { override: null, response: { jsonBody: { error: `DefectsOverrideReason must be text of ${REASON_MAX} characters or fewer` }, status: 400 }, warnings: covering };
  }
  const reason = text(raw);
  const canOverride = (await requireRole(request, DEFECTS_OVERRIDE_ROLES)) === null;
  if (reason && !canOverride) {
    return {
      override: null,
      response: { jsonBody: { error: "Only a facilities manager, director or admin can book work inside a defects period." }, status: 403 },
      warnings: covering,
    };
  }
  if (reason) return { override: { periods: held, reason }, warnings: covering };
  const missing = blocking.length > 0 ? null : missingAnswer(job, unanswered[0], today);
  const error = missing ? missingAnswerMessage(unanswered[0], missing, canOverride) : blockedMessage(held[0], canOverride);
  return {
    override: null,
    response: {
      jsonBody: { canOverride, code: "defects_period", error, missing, needsDetail: missing !== null, periods: held },
      status: 409,
    },
    warnings: covering,
  };
}

/** Runs inside the job insert's transaction: no ledger row, no job. */
export async function recordDefectsOverride(
  connection: Connection,
  request: HttpRequest,
  input: { buildingId: number; callerName: string; jobId: number; override: DefectsOverride },
): Promise<void> {
  const actor = await resolveLedgerActor(request, connection);
  if (!actor) throw new Error("Could not identify who is booking work inside a defects period");
  const [first] = input.override.periods;
  const covered = first
    ? `inside the ${first.works} defects period (to ${displayDate(first.endsOn)}${first.contractorName ? `, ${first.contractorName}` : ""})`
    : "inside a defects period";
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
     VALUES (@JobID, @CreatedBy, @Text, @EventType)`,
    [
      { name: "JobID", type: TYPES.Int, value: input.jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: input.callerName },
      { name: "Text", type: TYPES.NVarChar, value: `Booked anyway ${covered}: ${input.override.reason}` },
      { name: "EventType", type: TYPES.NVarChar, value: DEFECTS_OVERRIDE_EVENT },
    ],
  );
  await record(connection, {
    action: "job.defects_override",
    actor,
    buildingId: input.buildingId,
    computed: { coveredBy: input.override.periods.map((p) => ({ defectsPeriodId: p.defectsPeriodId, endsOn: p.endsOn, works: p.works })) },
    jobId: input.jobId,
    reason: input.override.reason,
    ruleApplied: "defects_period_block",
    subject: { id: input.jobId, type: "job" },
  });
}
