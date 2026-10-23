// A renewal's outcome (PLAN §3.6; WP33), in the caller's transaction:
//
//   renewed   a new lease term: a commencement row on the new commencement with
//             the new starting rent, written through the schedule engine (the
//             open-ended row before it is closed there; a schedule that already
//             has rows on or after it is refused, 422 schedule_conflict); the
//             tenancy's Commencement, Expiry, review cadence (interval, method,
//             fixed %) and options (when given) take the new lease's values;
//             ScheduleVersion + 1, sign-off kept (D7), NextReviewDate derived,
//             a stored holdover back to current
//   vacating  a draft vacancy for the tenancy (dbo.Vacancies, the vacancies
//             module's own table and defaults; never published from here), its
//             premises available from the lease's expiry; a vacancy of a test
//             tenancy is test data (D9). The tenancy stays current until it is
//             marked vacated.
//   holdover  the holdover terms on the tenancy; the stored status becomes
//             holdover once the expiry has passed. Before then the lease is still
//             running, so the stored status stays and the register derives
//             holdover from the day after the expiry (deriveTenantStatus), which
//             keeps the WP23a holdover reset's rule (stored holdover with a
//             future expiry is the bug it repairs) true.
// The event then closes with the outcome, and lease_event.{outcome} is ledgered
// with every value before and after.

import { randomUUID } from "node:crypto";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import type { RenewalOutcome } from "../leaseEventMachine";
import type { OptionMethodKind } from "../leaseOptions";
import { sqlDateToIso } from "../nextReviewDate";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { derivedNextReview } from "../rentReview/reviewTenancy";
import { placeStep, stepChanges } from "../rentReview/stepPlan";
import { diffSteps, parseSteps, type ScheduledRateStep } from "../scheduledRateStepLogic";
import { refuseClosedTenancy } from "./apply";
import { LeaseEventError } from "./http";
import { markDecided } from "./store";

export interface RenewedTerms {
  baseRentPerAnnum: number;
  commencement: string;
  expiry: string;
  fixedPercent: number | null;
  optionPeriods: string | null;
  optionsTotal: number | null;
  optionTermMonths: number | null;
  reviewIntervalMonths: number;
  reviewMethod: OptionMethodKind;
}

export type RenewalDecision =
  | { outcome: "renewed"; renewed: RenewedTerms }
  | { outcome: "vacating" }
  | { holdoverTerms: string; outcome: "holdover" };

export interface RenewalInput {
  actor: Extract<LedgerActor, { kind: "user" }>;
  actorOid: string;
  correlationId: string;
  decision: RenewalDecision;
  event: SqlRow;
  note: string | null;
  tenancy: SqlRow;
  today: string;
}

/** The register's free-text review type for a method, read back by mapMethodKind. */
export function reviewTypeText(method: OptionMethodKind, fixedPercent: number | null): string {
  if (method === "cpi") return "CPI";
  if (method === "market") return "Market review";
  if (method === "fixed") return fixedPercent === null ? "Fixed" : `Fixed ${fixedPercent}%`;
  return "Other";
}

const tenancyName = (row: SqlRow): string => {
  const trading = typeof row.TradingName === "string" ? row.TradingName.trim() : "";
  const legal = typeof row.LegalName === "string" ? row.LegalName.trim() : "";
  return trading || legal || `Tenancy ${row.TenantId}`;
};

function snapshot(row: SqlRow) {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    commencement: sqlDateToIso(row.Commencement),
    expiry: sqlDateToIso(row.Expiry),
    fixedReviewPercent: num(row.FixedReviewPercent),
    holdoverTerms: typeof row.HoldoverTerms === "string" ? row.HoldoverTerms : null,
    nextReviewDate: sqlDateToIso(row.NextReviewDate),
    optionPeriods: typeof row.OptionPeriods === "string" ? row.OptionPeriods : null,
    optionsRemaining: num(row.OptionsRemaining),
    optionsTotal: num(row.OptionsTotal),
    optionTermMonths: num(row.OptionTermMonths),
    reviewIntervalMonths: num(row.ReviewIntervalMonths),
    reviewType: typeof row.ReviewType === "string" ? row.ReviewType : null,
    scheduleVersion: Number(row.ScheduleVersion ?? 0),
    status: typeof row.Status === "string" ? row.Status : null,
  };
}

async function updateTenancy(connection: Connection, tenantId: number, sets: string[], params: SqlParam[], actor: { name: string; oid: string }, bumpSchedule: boolean): Promise<number | null> {
  const updateSet = [
    ...sets,
    ...(bumpSchedule ? ["ScheduleVersion = ScheduleVersion + 1"] : []),
    "UpdatedAt = SYSUTCDATETIME()",
    "UpdatedById = @UpdatedById",
    "UpdatedByName = @UpdatedByName",
  ].join(", ");
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Tenants SET ${updateSet}
     OUTPUT INSERTED.ScheduleVersion
     WHERE TenantId = @TenantId`,
    [
      ...params,
      { name: "TenantId", type: TYPES.Int, value: tenantId },
      { name: "UpdatedById", type: TYPES.NVarChar, value: actor.oid },
      { name: "UpdatedByName", type: TYPES.NVarChar, value: actor.name },
    ],
  );
  return rows[0] ? Number(rows[0].ScheduleVersion) : null;
}

async function renew(connection: Connection, input: RenewalInput, terms: RenewedTerms): Promise<Record<string, unknown>> {
  const { tenancy } = input;
  const tenantId = Number(tenancy.TenantId);
  const buildingId = Number(tenancy.BuildingId);
  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const clash = steps.filter((step) => step.effectiveFrom >= terms.commencement).map((step) => step.effectiveFrom).sort()[0];
  if (clash) {
    throw new LeaseEventError(
      "schedule_conflict",
      `The rent schedule already has rows from ${clash}, on or after the new commencement. Check them before recording the renewal.`,
      { from: clash },
    );
  }
  const step: ScheduledRateStep = {
    baseRentPerAnnum: terms.baseRentPerAnnum,
    effectiveFrom: terms.commencement,
    id: randomUUID(),
    methodKind: "commencement",
    note: "Lease renewed",
    ratePercent: 0,
  };
  const nextSteps = placeStep(steps, step).steps;
  const scheduleChanges: Array<{ changeId: string; kind: "added" | "updated"; stepId: string }> = [];
  for (const change of stepChanges(steps, nextSteps, step.id)) {
    scheduleChanges.push({
      changeId: await insertRentScheduleChangeLog(connection, {
        buildingId,
        changedById: input.actorOid,
        changedByName: input.actor.name,
        changeKind: change.kind,
        diff: change.before ? diffSteps(change.before, change.after) : null,
        stepId: change.after.id,
        stepSnapshot: change.after,
        tenantId,
      }),
      kind: change.kind,
      stepId: change.after.id,
    });
  }
  const reviewType = reviewTypeText(terms.reviewMethod, terms.fixedPercent);
  const next = derivedNextReview(
    { ...tenancy, Commencement: terms.commencement, ReviewIntervalMonths: terms.reviewIntervalMonths },
    nextSteps,
    {},
    input.today,
  );
  const sets = [
    "ScheduledRateSteps = @Steps",
    "Commencement = @Commencement",
    "Expiry = @Expiry",
    "ReviewIntervalMonths = @ReviewIntervalMonths",
    "ReviewType = @ReviewType",
    "FixedReviewPercent = @FixedReviewPercent",
  ];
  const params: SqlParam[] = [
    { name: "Steps", type: TYPES.NVarChar, value: JSON.stringify(nextSteps) },
    { name: "Commencement", type: TYPES.Date, value: terms.commencement },
    { name: "Expiry", type: TYPES.Date, value: terms.expiry },
    { name: "ReviewIntervalMonths", type: TYPES.Int, value: terms.reviewIntervalMonths },
    { name: "ReviewType", type: TYPES.NVarChar, value: reviewType },
    { name: "FixedReviewPercent", options: { precision: 13, scale: 10 }, type: TYPES.Decimal, value: terms.reviewMethod === "fixed" ? terms.fixedPercent : null },
  ];
  if (terms.optionsTotal !== null) {
    sets.push("OptionsTotal = @OptionsTotal", "OptionsRemaining = @OptionsTotal", "OptionTermMonths = @OptionTermMonths");
    params.push({ name: "OptionsTotal", type: TYPES.Int, value: terms.optionsTotal }, { name: "OptionTermMonths", type: TYPES.Int, value: terms.optionTermMonths });
  }
  if (terms.optionPeriods !== null) {
    sets.push("OptionPeriods = @OptionPeriods");
    params.push({ name: "OptionPeriods", type: TYPES.NVarChar, value: terms.optionPeriods });
  }
  if (next) {
    sets.push("NextReviewDate = @NextReviewDate");
    params.push({ name: "NextReviewDate", type: TYPES.Date, value: next.after });
  }
  if (tenancy.Status === "holdover" && terms.expiry >= input.today) sets.push("Status = 'current'");
  const scheduleVersion = await updateTenancy(connection, tenantId, sets, params, { name: input.actor.name, oid: input.actorOid }, true);
  return { nextReviewDate: next?.after ?? sqlDateToIso(tenancy.NextReviewDate), reviewType, scheduleChanges, scheduleVersion, step, terms };
}

async function vacate(connection: Connection, input: RenewalInput): Promise<Record<string, unknown>> {
  const { tenancy } = input;
  const availableFrom = sqlDateToIso(tenancy.Expiry);
  const buildingName = typeof tenancy.BuildingName === "string" && tenancy.BuildingName.trim() ? tenancy.BuildingName.trim() : null;
  const title = [tenancyName(tenancy), buildingName].filter(Boolean).join(" · ").slice(0, 255) || "New vacancy";
  const rows = await executeQuery(
    connection,
    `INSERT INTO dbo.Vacancies (Title, Status, AdditionalDetails, Images, TenancyId, BuildingId, IsTest, AvailableFrom)
     OUTPUT INSERTED.Id
     VALUES (@Title, 'draft', '[]', '[]', @TenancyId, @BuildingId, @IsTest, @AvailableFrom)`,
    [
      { name: "Title", type: TYPES.NVarChar, value: title },
      { name: "TenancyId", type: TYPES.Int, value: Number(tenancy.TenantId) },
      { name: "BuildingId", type: TYPES.Int, value: tenancy.BuildingId === null ? null : Number(tenancy.BuildingId) },
      { name: "IsTest", type: TYPES.Bit, value: tenancy.IsTest === true || tenancy.IsTest === 1 },
      { name: "AvailableFrom", type: TYPES.Date, value: availableFrom },
    ],
  );
  return { availableFrom, title, vacancyId: rows[0] ? Number(rows[0].Id) : null };
}

async function holdOver(connection: Connection, input: RenewalInput, terms: string): Promise<Record<string, unknown>> {
  const { tenancy } = input;
  const expiry = sqlDateToIso(tenancy.Expiry);
  const expired = expiry !== null && expiry < input.today;
  const sets = ["HoldoverTerms = @HoldoverTerms"];
  if (expired) sets.push("Status = 'holdover'");
  await updateTenancy(connection, Number(tenancy.TenantId), sets, [{ name: "HoldoverTerms", type: TYPES.NVarChar, value: terms }], { name: input.actor.name, oid: input.actorOid }, false);
  return { holdoverFrom: expiry, holdoverTerms: terms, status: expired ? "holdover" : `holdover from the day after ${expiry}` };
}

export async function decideRenewal(connection: Connection, input: RenewalInput): Promise<{ buildingId: number; details: Record<string, unknown>; tenantId: number }> {
  const { event, tenancy } = input;
  const leaseEventId = String(event.LeaseEventId);
  const tenantId = Number(tenancy.TenantId);
  const buildingId = Number(tenancy.BuildingId);
  refuseClosedTenancy(tenancy);
  const expiry = sqlDateToIso(tenancy.Expiry);
  if (!expiry || expiry !== sqlDateToIso(event.LeaseExpiry)) {
    throw new LeaseEventError("expiry_changed", "The lease's expiry has changed since this renewal was referred. Check the tenancy first.");
  }
  const before = snapshot(tenancy);
  const decision = input.decision;
  const details =
    decision.outcome === "renewed"
      ? await renew(connection, input, decision.renewed)
      : decision.outcome === "vacating"
        ? await vacate(connection, input)
        : await holdOver(connection, input, decision.holdoverTerms);
  const outcome: RenewalOutcome = decision.outcome;
  const moved = await markDecided(connection, leaseEventId, ["referred"], outcome, {
    decider: { name: input.actor.name, userId: input.actor.userId },
    details,
    outcome,
    reason: input.note,
  });
  if (!moved) throw new LeaseEventError("invalid_state", "This renewal just moved on, so the decision wasn't recorded.");
  await ledger.record(connection, {
    action: `lease_event.${outcome}`,
    actor: input.actor,
    after: { ...details, state: outcome },
    before: { state: "referred", tenancy: before },
    buildingId,
    correlationId: input.correlationId,
    reason: input.note,
    ruleApplied: `renewal_${outcome}`,
    subject: { id: leaseEventId, type: "lease_event" },
    tenantId,
  });
  return { buildingId, details, tenantId };
}
