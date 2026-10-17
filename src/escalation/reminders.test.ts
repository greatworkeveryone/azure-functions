/// <reference types="jest" />
import { dueReminder } from "./reminders";
import type { EscalationRow } from "./types";

const at = (iso: string): Date => new Date(iso);

// Mon 12 Oct 2026, 09:00 Darwin = 23:30Z on the 11th
const RAISED = at("2026-10-11T23:30:00Z");
// 08:30 Darwin on Fri 16, Mon 19 and Tue 20 Oct
const FRI = "2026-10-15T23:00:00.000Z";
const MON = "2026-10-18T23:00:00.000Z";
const TUE = "2026-10-19T23:00:00.000Z";

function decisionRow(over: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: { schedule: { remindAt: [FRI, MON, TUE] }, userTargets: [3, 5] },
    createdAt: RAISED,
    dueAt: at("2026-10-20T07:30:00Z"),
    escalationId: 42,
    kind: "authority",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: RAISED,
    lastNotificationError: null,
    lastNotifiedAt: RAISED,
    level: 1,
    noIndependentTarget: false,
    note: "Pay it?",
    notificationAttempts: 1,
    notificationState: "sent",
    parentEscalationId: null,
    policyKey: "job.decision_pending",
    raisedByKind: "user",
    raisedByName: "Alana",
    raisedByUserId: 9,
    reason: "needs_decision",
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: "AAAAAAAAB9A=",
    status: "open",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12 — Decision needed: Pay it?",
    targetRole: null,
    targetUserId: null,
    updatedAt: RAISED,
    urgent: false,
    ...over,
  };
}

describe("dueReminder", () => {
  it("is null before the first reminder's time", () => {
    expect(dueReminder(decisionRow(), at("2026-10-15T22:59:59Z"))).toBeNull();
  });

  it("is that reminder from its time on", () => {
    expect(dueReminder(decisionRow(), at(FRI))?.toISOString()).toBe(FRI);
    expect(dueReminder(decisionRow(), at("2026-10-16T05:00:00Z"))?.toISOString()).toBe(FRI);
  });

  it("is null once the people have been told since: the send is the cursor", () => {
    const told = decisionRow({ lastNotifiedAt: at("2026-10-15T23:05:00Z") });
    expect(dueReminder(told, at("2026-10-16T05:00:00Z"))).toBeNull();
  });

  it("is not due when the people were told at the very moment it was scheduled for", () => {
    expect(dueReminder(decisionRow({ lastNotifiedAt: at(FRI) }), at("2026-10-16T05:00:00Z"))).toBeNull();
  });

  it("is due at the very moment it is scheduled for, not a moment before", () => {
    expect(dueReminder(decisionRow(), at("2026-10-15T22:59:59.999Z"))).toBeNull();
    expect(dueReminder(decisionRow(), at(FRI))?.toISOString()).toBe(FRI);
  });

  it("is the next one when the time for it comes", () => {
    const told = decisionRow({ lastNotifiedAt: at("2026-10-15T23:05:00Z") });
    expect(dueReminder(told, at(MON))?.toISOString()).toBe(MON);
  });

  it("sends one reminder for several missed, the latest, not one for each (a sweep that was off)", () => {
    expect(dueReminder(decisionRow(), at("2026-10-20T01:00:00Z"))?.toISOString()).toBe(TUE);
  });

  it("is the same answer asked twice, until a send gets through", () => {
    const now = at("2026-10-16T05:00:00Z");
    expect(dueReminder(decisionRow(), now)).toEqual(dueReminder(decisionRow(), now));
  });

  it("counts from when the row was raised when the people were never told", () => {
    const never = decisionRow({ lastNotifiedAt: null });
    expect(dueReminder(never, at("2026-10-16T05:00:00Z"))?.toISOString()).toBe(FRI);
    // a reminder before the row existed is not due
    const lateRaised = decisionRow({ createdAt: at("2026-10-16T01:00:00Z"), lastNotifiedAt: null });
    expect(dueReminder(lateRaised, at("2026-10-16T05:00:00Z"))).toBeNull();
  });

  it("applies to an open row and to an acknowledged one, not to one that has ended", () => {
    const now = at("2026-10-16T05:00:00Z");
    expect(dueReminder(decisionRow({ status: "open" }), now)).not.toBeNull();
    expect(dueReminder(decisionRow({ status: "acknowledged" }), now)).not.toBeNull();
    for (const status of ["resolved", "superseded", "withdrawn"] as const) {
      expect(dueReminder(decisionRow({ status }), now)).toBeNull();
    }
  });

  it("does not remind the next level: a row that has moved up carries no schedule of its own", () => {
    const movedUp = decisionRow({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" });
    expect(dueReminder(movedUp, at("2026-10-20T01:00:00Z"))).toBeNull();
  });

  it("is null for a row with no schedule, which is every other escalation", () => {
    expect(dueReminder(decisionRow({ context: { title: "Leaking roof" } }), at("2026-10-20T01:00:00Z"))).toBeNull();
    expect(dueReminder(decisionRow({ context: null }), at("2026-10-20T01:00:00Z"))).toBeNull();
    expect(dueReminder(decisionRow({ context: { schedule: { remindAt: [] } } }), at("2026-10-20T01:00:00Z"))).toBeNull();
  });
});
