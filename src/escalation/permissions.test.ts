/// <reference types="jest" />
import "./adapters";
import { toDto } from "./dto";
import {
  assertCan,
  availableActions,
  canAct,
  canEscalateFurther,
  canSee,
  canWithdraw,
  isAdmin,
  isOversight,
  isRaiser,
  isTargetOf,
  isWithdrawable,
} from "./permissions";
import type { DirectoryUser, EscalationRow, Viewer } from "./types";

const viewer = (userId: number | null, ...roles: string[]): Viewer => ({ name: `User ${userId}`, roles, userId });

const FM_ADAM = viewer(1, "facilities_manager");
const FM_BEA = viewer(2, "facilities_manager");
const FAY = viewer(8, "facilities");
const GUS = viewer(9, "accounts");
const CAM = viewer(3, "accounts_manager");
const JOH = viewer(4, "cfo");
const DEE = viewer(5, "director");
const ADA = viewer(7, "admin");

function row(overrides: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: null,
    createdAt: new Date("2026-10-13T00:00:00Z"),
    dueAt: new Date("2026-10-14T06:00:00Z"),
    escalationId: 42,
    kind: "attention",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: null,
    lastNotificationError: "Graph sendMail failed: 401",
    lastNotifiedAt: null,
    level: 1,
    noIndependentTarget: false,
    note: null,
    notificationAttempts: 1,
    notificationState: "failed",
    parentEscalationId: null,
    policyKey: "job.manual",
    raisedByKind: "user",
    raisedByName: "Fay",
    raisedByUserId: 8,
    reason: "stalled",
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: "AAAAAAAAB9A=",
    status: "open",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12",
    targetRole: "facilities_manager",
    targetUserId: null,
    updatedAt: new Date("2026-10-13T00:00:00Z"),
    urgent: false,
    ...overrides,
  };
}

describe("who sees an escalation (§3.7: the targets, the raiser, every role above the target)", () => {
  it("the people it goes to see it", () => {
    expect(canSee(FM_ADAM, row())).toBe(true);
    expect(canSee(FM_BEA, row())).toBe(true);
  });

  it("the raiser sees it", () => {
    expect(canSee(FAY, row())).toBe(true);
  });

  it("every role above the target sees it", () => {
    expect(canSee(DEE, row())).toBe(true);
    expect(canSee(ADA, row())).toBe(true);
    expect(canSee(JOH, row())).toBe(true);
  });

  it("peers on the other side, and staff below, do not", () => {
    expect(canSee(CAM, row())).toBe(false);
    expect(canSee(GUS, row())).toBe(false);
    expect(canSee(viewer(10, "facilities"), row())).toBe(false);
  });

  it("a manager sees what their own staff raised, even when it goes higher", () => {
    const toDirector = row({ targetRole: "director" });
    expect(canSee(FM_ADAM, toDirector)).toBe(false);
    expect(canSee(FM_ADAM, toDirector, "facilities")).toBe(true);
    expect(canSee(CAM, toDirector, "facilities")).toBe(false);
  });

  it("a person named as the target sees it whatever their role", () => {
    expect(canSee(viewer(77, "accounts"), row({ targetUserId: 77 }))).toBe(true);
  });

  it("a flagged escalation (nobody independent) is visible to all directors and admin", () => {
    const flagged = row({ noIndependentTarget: true, raisedByUserId: 5, targetRole: "director" });
    expect(canSee(viewer(6, "director"), flagged)).toBe(true);
    expect(canSee(ADA, flagged)).toBe(true);
    expect(canSee(DEE, flagged)).toBe(true);
    expect(canSee(FM_ADAM, flagged)).toBe(false);
  });
});

describe("the CFO oversees every finance. alert: sees them all, acts on none that isn't aimed at her", () => {
  // Raised by Floorplan itself, so no raiser's team comes into it.
  const finance = (overrides: Partial<EscalationRow> = {}) =>
    row({
      policyKey: "finance.variance_disputed",
      raisedByKind: "system",
      raisedByName: "Floorplan",
      raisedByUserId: null,
      targetRole: "director",
      ...overrides,
    });
  const NONE = { acknowledge: false, escalateFurther: false, resolve: false, withdraw: false };

  it("sees one aimed at a director, at admin or at a named person, which she could not before", () => {
    expect(canSee(JOH, finance({ policyKey: "job.critical" }))).toBe(false);
    expect(canSee(JOH, finance())).toBe(true);
    expect(canSee(JOH, finance({ targetRole: "admin" }))).toBe(true);
    expect(canSee(JOH, finance({ targetRole: "director", targetUserId: 5 }))).toBe(true);
  });

  it("sees every one of the Finance workspace's policies", () => {
    for (const key of ["finance.attribution_disputed", "finance.variance_disputed", "finance.repeated_denials", "finance.myob_write_failed"]) {
      expect(canSee(JOH, finance({ policyKey: key }))).toBe(true);
    }
  });

  it("still cannot see a non-finance escalation aimed at a director", () => {
    expect(canSee(JOH, finance({ policyKey: "job.critical" }))).toBe(false);
    expect(canSee(JOH, finance({ policyKey: "rent_review.approval" }))).toBe(false);
    expect(canSee(JOH, finance({ policyKey: "system.health", targetRole: "admin" }))).toBe(false);
  });

  it("matches the prefix finance., not any key that begins with the word", () => {
    expect(canSee(JOH, finance({ policyKey: "financex.variance_disputed" }))).toBe(false);
    expect(canSee(JOH, finance({ policyKey: "finance" }))).toBe(false);
    expect(canSee(JOH, finance({ policyKey: "any.finance.thing" }))).toBe(false);
  });

  it("compares the key the way the database does: without regard to case", () => {
    expect(canSee(JOH, finance({ policyKey: "Finance.Variance_Disputed" }))).toBe(true);
  });

  it("gives nobody else anything: the other roles see exactly what they saw before", () => {
    for (const who of [CAM, FM_ADAM, FAY, GUS, viewer(10, "user")]) {
      expect(canSee(who, finance())).toBe(false);
    }
    // Directors and admin already saw everything.
    expect(canSee(DEE, finance())).toBe(true);
    expect(canSee(ADA, finance())).toBe(true);
  });

  it("changes nothing for a finance escalation she could already see", () => {
    expect(canSee(JOH, finance({ targetRole: "accounts_manager" }))).toBe(true);
    expect(canSee(JOH, finance({ targetRole: "cfo" }))).toBe(true);
  });

  it("seeing is not acting: every action is off for one that isn't aimed at her", () => {
    for (const status of ["open", "acknowledged"] as const) {
      for (const kind of ["attention", "authority"] as const) {
        const aimedAtDirector = finance({ kind, status });
        expect(availableActions(JOH, aimedAtDirector)).toEqual(NONE);
        expect(canAct(JOH, aimedAtDirector)).toBe(false);
        expect(canWithdraw(JOH, aimedAtDirector)).toBe(false);
        expect(canEscalateFurther(JOH, aimedAtDirector)).toBe(false);
      }
    }
  });

  it("acts only where the existing rules say: as the target", () => {
    expect(availableActions(JOH, finance({ targetRole: "cfo" }))).toEqual({ acknowledge: true, escalateFurther: true, resolve: true, withdraw: false });
    expect(availableActions(JOH, finance({ targetUserId: 4 }))).toMatchObject({ acknowledge: true, resolve: true });
    // Seeing a colleague's named escalation is not being its target.
    expect(availableActions(JOH, finance({ targetRole: "cfo", targetUserId: 99 }))).toEqual(NONE);
  });
});

describe("who is a target", () => {
  it("is everyone in the role until a person is named", () => {
    expect(isTargetOf(FM_ADAM, row())).toBe(true);
    expect(isTargetOf(FM_BEA, row())).toBe(true);
    expect(isTargetOf(FAY, row())).toBe(false);
  });

  it("is the named person alone once the raiser picked one", () => {
    const picked = row({ targetUserId: 1 });
    expect(isTargetOf(FM_ADAM, picked)).toBe(true);
    expect(isTargetOf(FM_BEA, picked)).toBe(false);
  });

  it("is anyone in the role again once a colleague has acknowledged it", () => {
    const claimed = row({ status: "acknowledged", targetUserId: 1 });
    expect(isTargetOf(FM_ADAM, claimed)).toBe(true);
    expect(isTargetOf(FM_BEA, claimed)).toBe(true);
  });

  it("includes directors and admin when nobody independent is available", () => {
    expect(isTargetOf(DEE, row({ noIndependentTarget: true, targetRole: "director" }))).toBe(true);
    expect(isTargetOf(ADA, row({ noIndependentTarget: true, targetRole: "director" }))).toBe(true);
  });
});

describe("acting on an escalation", () => {
  it("the people it goes to, and oversight, can; the raiser cannot", () => {
    expect(canAct(FM_ADAM, row())).toBe(true);
    expect(canAct(DEE, row())).toBe(true);
    expect(canAct(ADA, row())).toBe(true);
    expect(canAct(FAY, row())).toBe(false);
    expect(canAct(GUS, row())).toBe(false);
  });

  it("a director who raised it cannot act on it, even when it goes to the directors", () => {
    const flagged = row({ noIndependentTarget: true, raisedByUserId: 5, targetRole: "director" });
    expect(canAct(DEE, flagged)).toBe(false);
    expect(canAct(ADA, flagged)).toBe(true);
  });

  it("the raiser can withdraw and push further; so can admin withdraw", () => {
    expect(canWithdraw(FAY, row())).toBe(true);
    expect(canWithdraw(ADA, row())).toBe(true);
    expect(canWithdraw(FM_ADAM, row())).toBe(false);
    expect(canWithdraw(DEE, row())).toBe(false);
    expect(canEscalateFurther(FAY, row())).toBe(true);
    expect(canEscalateFurther(FM_ADAM, row())).toBe(true);
    expect(canEscalateFurther(GUS, row())).toBe(false);
  });

  it("offers each button only when it would work", () => {
    expect(availableActions(FM_ADAM, row())).toEqual({ acknowledge: true, escalateFurther: true, resolve: true, withdraw: false });
    expect(availableActions(FAY, row())).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: true });
    expect(availableActions(GUS, row())).toEqual({ acknowledge: false, escalateFurther: false, resolve: false, withdraw: false });
  });

  it("an acknowledged escalation can't be acknowledged again or withdrawn", () => {
    const claimed = row({ status: "acknowledged", targetUserId: 1 });
    expect(availableActions(FM_ADAM, claimed)).toEqual({ acknowledge: false, escalateFurther: true, resolve: true, withdraw: false });
    expect(availableActions(FAY, claimed).withdraw).toBe(false);
  });

  it("an authority escalation can't be resolved from here", () => {
    const authority = row({ kind: "authority", targetRole: "accounts_manager" });
    expect(availableActions(CAM, authority)).toEqual({ acknowledge: true, escalateFurther: true, resolve: false, withdraw: false });
  });

  it("a closed escalation offers nothing", () => {
    for (const status of ["resolved", "superseded", "withdrawn"] as const) {
      expect(availableActions(FM_ADAM, row({ status }))).toEqual({ acknowledge: false, escalateFurther: false, resolve: false, withdraw: false });
      expect(availableActions(FAY, row({ status }))).toEqual({ acknowledge: false, escalateFurther: false, resolve: false, withdraw: false });
    }
  });

  it("assertCan throws a 403 EscalationError", () => {
    expect(() => assertCan(true, "no")).not.toThrow();
    expect(() => assertCan(false, "Only the target")).toThrow(expect.objectContaining({ code: "forbidden", message: "Only the target", status: 403 }));
  });

  it("knows the raiser, oversight and admin", () => {
    expect(isRaiser(FAY, row())).toBe(true);
    expect(isRaiser(viewer(null, "facilities"), row({ raisedByUserId: null }))).toBe(false);
    expect(isOversight(DEE)).toBe(true);
    expect(isOversight(JOH)).toBe(false);
    expect(isAdmin(ADA)).toBe(true);
    expect(isAdmin(DEE)).toBe(false);
  });
});

describe("the DTO", () => {
  const directory: DirectoryUser[] = [{ email: "a@example.com", name: "Adam", role: "facilities_manager", userId: 1 }];
  const now = new Date("2026-10-15T00:00:00Z");

  it("sends ISO dates, labels, the version and what the viewer can do", () => {
    const dto = toDto(row({ targetUserId: 1 }), FM_ADAM, now, directory);

    expect(dto).toMatchObject({
      actions: { acknowledge: true, resolve: true },
      createdAt: "2026-10-13T00:00:00.000Z",
      deepLink: "/jobs?jobId=12",
      dueAt: "2026-10-14T06:00:00.000Z",
      escalationId: 42,
      isOverdue: true,
      reasonLabel: "Stalled",
      rowVersion: "AAAAAAAAB9A=",
      targetRoleLabel: "Facilities manager",
      targetUserName: "Adam",
    });
  });

  it("is overdue only while open and past due", () => {
    expect(toDto(row(), FM_ADAM, new Date("2026-10-13T12:00:00Z"), directory).isOverdue).toBe(false);
    expect(toDto(row({ status: "acknowledged" }), FM_ADAM, now, directory).isOverdue).toBe(false);
    expect(toDto(row({ dueAt: null }), FM_ADAM, now, directory).isOverdue).toBe(false);
  });

  it("shows the email error only to directors and admin", () => {
    expect(toDto(row(), FM_ADAM, now, directory).lastNotificationError).toBeNull();
    expect(toDto(row(), DEE, now, directory).lastNotificationError).toBe("Graph sendMail failed: 401");
    expect(toDto(row(), ADA, now, directory).lastNotificationError).toBe("Graph sendMail failed: 401");
  });

  it("has no deep link for a subject type nobody registered", () => {
    expect(toDto(row({ subjectType: "mystery" }), DEE, now, directory).deepLink).toBeNull();
  });
});

describe("L3: a rent review's approval ends only with the review's decision", () => {
  const approval = (over: Partial<EscalationRow> = {}) =>
    row({ kind: "authority", policyKey: "rent_review.approval", raisedByUserId: 9, subjectId: "rev-1", subjectType: "rent_review", ...over });

  it("can't be withdrawn by its raiser (the preparer) or by admin", () => {
    expect(isWithdrawable(approval())).toBe(false);
    expect(canWithdraw(GUS, approval())).toBe(false);
    expect(canWithdraw(ADA, approval())).toBe(false);
    expect(availableActions(GUS, approval()).withdraw).toBe(false);
  });

  it("leaves a review's attention escalations to the usual rule", () => {
    const overdue = approval({ kind: "attention", policyKey: "rent_review.overdue", raisedByKind: "system", raisedByUserId: null });
    expect(isWithdrawable(overdue)).toBe(true);
    expect(canWithdraw(ADA, overdue)).toBe(true);
  });
});
