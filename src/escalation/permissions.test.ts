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
