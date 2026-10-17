/// <reference types="jest" />
import { buildDecisionEmail } from "./decisionEmail";
import { buildEmail } from "./notifier";
import type { EscalationRow } from "./types";

jest.mock("./store", () => ({ listActiveUsers: jest.fn(), recordNotification: jest.fn() }));

const LINK = "https://floorplan.example/jobs?jobId=12";
const ASKED = ["Dee", "Eli", "Cam"];

const decision = {
  assignmentMode: "named",
  callThem: false,
  jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
  question: "Pay the superseded lighting invoice, or go back to the contractor?",
  requestId: 7,
  respondBy: "2026-10-20T07:30:00.000Z",
  tier: "soon",
};

function row(over: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: { decision, userTargets: [5, 6, 3] },
    createdAt: new Date("2026-10-12T00:00:00Z"),
    dueAt: new Date("2026-10-20T07:30:00Z"),
    escalationId: 42,
    kind: "authority",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: null,
    lastNotificationError: null,
    lastNotifiedAt: null,
    level: 1,
    noIndependentTarget: false,
    note: decision.question,
    notificationAttempts: 0,
    notificationState: "pending",
    parentEscalationId: null,
    policyKey: "job.decision_pending",
    raisedByKind: "user",
    raisedByName: "Alana Accounts",
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
    summary: "Job #12 · Superseded lighting invoice · 25 Temira Crescent — Decision needed: Pay the superseded lighting invoice",
    targetRole: null,
    targetUserId: null,
    updatedAt: new Date("2026-10-12T00:00:00Z"),
    urgent: false,
    ...over,
  };
}

const lines = (email: { body: string } | null): string[] => (email ? email.body.split("\n") : []);

describe("a decision request's first email", () => {
  const email = buildDecisionEmail("raise", row(), LINK, ASKED)!;

  it("names the question, the job, who was asked, who asked and when an answer is due, with the link", () => {
    expect(lines(email)).toEqual([
      "Hi,",
      "",
      "Alana Accounts has asked for a decision in Floorplan.",
      "",
      "Question: Pay the superseded lighting invoice, or go back to the contractor?",
      "Job: Job #12 · Superseded lighting invoice · 25 Temira Crescent",
      "Asked of: Dee, Eli, Cam",
      "Raised by: Alana Accounts",
      "Respond by: 20/10/2026 17:00 Darwin time",
      "",
      `Open it in Floorplan: ${LINK}`,
      "",
      "This email only points you to Floorplan. Decisions are made there, not by replying.",
      "",
    ]);
  });

  it("puts the job in the subject, so the inbox says what it is about", () => {
    expect(email.subject).toBe("Decision needed: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
  });

  it("says URGENT for an urgent request", () => {
    expect(buildDecisionEmail("raise", row({ urgent: true }), LINK, ASKED)!.subject).toMatch(/^URGENT decision needed: Job #12/);
  });

  it("says to call them for an emergency, and gives no deadline", () => {
    const emergency = buildDecisionEmail(
      "raise",
      row({ context: { decision: { ...decision, callThem: true, respondBy: null, tier: "emergency" }, userTargets: [5] }, urgent: true }),
      LINK,
      ["Dee"],
    )!;
    expect(emergency.subject).toMatch(/^EMERGENCY decision needed: Job #12/);
    expect(emergency.body).toContain("This is an emergency. Alana Accounts has raised it and needs you to call them now. Floorplan will not chase it.");
    expect(emergency.body).not.toContain("Respond by:");
  });

  it("points at the app when no link is configured", () => {
    expect(buildDecisionEmail("raise", row(), null, ASKED)!.body).toContain("Open Floorplan to see it.");
  });

  it("leaves the asked-of line out when nobody is known", () => {
    expect(buildDecisionEmail("raise", row(), LINK, [])!.body).not.toContain("Asked of:");
  });

  it("clips a very long question and keeps the subject within a line", () => {
    const long = "Why? ".repeat(600);
    const clipped = buildDecisionEmail("raise", row({ context: { decision: { ...decision, question: long }, userTargets: [5] } }), LINK, ASKED)!;
    const question = lines(clipped).find((l) => l.startsWith("Question: "))!;
    expect(question.length).toBeLessThanOrEqual("Question: ".length + 1500 + 3);
    expect(question.endsWith("...")).toBe(true);
    expect(clipped.subject.length).toBeLessThanOrEqual(250);
  });

  it("uses the summary when the job's label was not recorded", () => {
    const noLabel = buildDecisionEmail("raise", row({ context: { decision: { ...decision, jobLabel: undefined }, userTargets: [5] } }), LINK, ASKED)!;
    expect(noLabel.subject).toMatch(/^Decision needed: Job #12 · Superseded lighting invoice · 25 Temira Crescent — Decision needed/);
  });
});

describe("the other events of a decision request", () => {
  it("a reminder says the decision is still waiting", () => {
    const email = buildDecisionEmail("reminder", row(), LINK, ASKED)!;
    expect(email.subject).toBe("Reminder, decision needed: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(email.body).toContain("A decision is still waiting for you.");
    expect(email.body).toContain("Respond by: 20/10/2026 17:00 Darwin time");
  });

  it("moving up tells the manager it is overdue and who it was asked of, not that someone is waiting to be picked up", () => {
    const moved = row({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" });
    const email = buildDecisionEmail("supersede", moved, LINK, ASKED)!;
    expect(email.subject).toMatch(/^Decision overdue, escalated to you: Job #12/);
    expect(email.body).toContain("A decision was not made by the time it was due, so it has been escalated to you.");
    expect(email.body).toContain("Asked of: Dee, Eli, Cam");
    expect(email.body).not.toMatch(/pick(ed)? (it )?up/);
  });

  it("says so in the subject when an urgent request is escalated", () => {
    const moved = row({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager", urgent: true });
    expect(buildDecisionEmail("supersede", moved, LINK, ASKED)!.subject).toMatch(/^URGENT decision overdue, escalated to you:/);
  });

  it("tells the people it was asked of that it still needs their decision, never that they need do nothing", () => {
    const moved = row({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" });
    const email = buildDecisionEmail("fyi", moved, LINK, ASKED)!;
    expect(email.subject).toMatch(/^FYI, decision escalated: Job #12/);
    expect(email.body).toContain("This decision is overdue and has been escalated to Accounts manager. It still needs your decision.");
    expect(email.body).not.toContain("You don't need to do anything");
  });

  it("closing says so, and gives no deadline", () => {
    const email = buildDecisionEmail("resolved", row(), LINK, ASKED)!;
    expect(email.subject).toMatch(/^Decision closed: /);
    expect(email.body).toContain("This decision request has been closed.");
    expect(email.body).not.toContain("Respond by:");
  });

  it("a follow-up reads as a reminder", () => {
    expect(buildDecisionEmail("follow_up", row(), LINK, ASKED)!.body).toContain("A decision is still waiting for you.");
  });
});

describe("what is not a decision request", () => {
  it("gets no decision email", () => {
    expect(buildDecisionEmail("raise", row({ policyKey: "job.manual" }), LINK, ASKED)).toBeNull();
    expect(buildDecisionEmail("raise", row({ context: null }), LINK, ASKED)).toBeNull();
    expect(buildDecisionEmail("raise", row({ context: { decision: { requestId: 7 } } }), LINK, ASKED)).toBeNull();
  });

  it("the notifier's buildEmail uses the decision wording for a decision and the usual wording for anything else", () => {
    expect(buildEmail("raise", row(), LINK, ASKED).subject).toMatch(/^Decision needed: /);
    const ordinary = buildEmail("raise", row({ context: null, policyKey: "job.manual", targetRole: "facilities_manager" }), LINK);
    expect(ordinary.subject).toMatch(/^Escalation: /);
    expect(ordinary.body).toContain("Something needs your attention in Floorplan.");
  });
});
