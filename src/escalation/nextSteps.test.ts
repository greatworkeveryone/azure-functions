/// <reference types="jest" />
// The next step a decision hands on (jobs plan A2) is an attention escalation on the
// job with rules of its own: it is done on the job, not claimed, resolved or withdrawn
// from the inbox; it is chased through its OWNER's manager; and its emails say what was
// decided and what to do. This pins each place that has to know, and the same for a
// deferred question coming round again.
import type { Connection } from "tedious";
import "./adapters";
import { decisionOf, isNextStepRow, ladderOf, nextStepOf } from "./decisionRows";
import { buildDecisionEmail } from "./decisionEmail";
import { toDto } from "./dto";
import { buildEmail, notifyTargets, targetAddresses, targetUsers, type NotifyOptions } from "./notifier";
import { buildNextStepEmail, outcomeLabel } from "./nextStepEmail";
import { availableActions, canAct, canSee, canWithdraw } from "./permissions";
import type { DirectoryUser, EscalationRow, Viewer } from "./types";

jest.mock("./store", () => ({
  ...jest.requireActual("./store"),
  listActiveUsers: jest.fn(),
  recordNotification: jest.fn().mockResolvedValue(undefined),
}));

const conn = {} as Connection;
const NOW = new Date("2026-10-13T01:00:00Z");
const LINK = "https://floorplan.example/jobs?jobId=12";

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const KIRSTIN = user(4, "Kirstin", "accounts_manager");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const GUS = user(10, "Gus", "accounts");
const USERS = [CAM, KIRSTIN, DEE, ELI, FAY, ALANA, GUS];

const ENV = {
  APP_BASE_URL: "https://floorplan.example",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
} as NodeJS.ProcessEnv;

const viewer = (u: DirectoryUser): Viewer => ({ name: u.name, roles: [u.role], userId: u.userId });

const nextStep = {
  decisionId: 4,
  dueAt: "2026-10-20T07:30:00.000Z",
  jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
  nextStep: "Pay the invoice\nand file the receipt",
  outcome: "approve",
  ownerRole: null,
  ownerUserId: 9,
  rationale: "The lighting was ordered twice and the first order was paid.",
  requestId: 7,
  respondedBy: "Dee",
};

/** An open next step handed to Alana by Dee, chased through Alana's manager. */
function step(over: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: { ladder: { role: "accounts", userId: ALANA.userId }, nextStep, schedule: { escalateAt: "2026-10-20T07:30:00.000Z", remindAt: [] }, userTargets: [ALANA.userId] },
    createdAt: new Date("2026-10-12T00:00:00Z"),
    dueAt: new Date("2026-10-20T07:30:00Z"),
    escalationId: 43,
    kind: "attention",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: null,
    lastNotificationError: null,
    lastNotifiedAt: null,
    level: 1,
    noIndependentTarget: false,
    note: nextStep.nextStep,
    notificationAttempts: 0,
    notificationState: "pending",
    parentEscalationId: null,
    policyKey: "job.next_step",
    raisedByKind: "user",
    raisedByName: "Dee",
    raisedByUserId: DEE.userId,
    reason: null,
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: "AAAAAAAAB9A=",
    status: "open",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12 · Superseded lighting invoice · 25 Temira Crescent — Next step: Pay the invoice and file the receipt",
    targetRole: "accounts",
    targetUserId: ALANA.userId,
    updatedAt: new Date("2026-10-12T00:00:00Z"),
    urgent: false,
    ...over,
  };
}

/** The same step after it moved up to Alana's manager (a role level). */
const movedUp = (over: Partial<EscalationRow> = {}): EscalationRow =>
  step({ level: 2, parentEscalationId: 42, targetRole: "accounts_manager", targetUserId: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  (require("./store") as { recordNotification: jest.Mock }).recordNotification.mockResolvedValue(undefined);
  delete process.env.DEV_EMAIL_OVERRIDE;
});
afterEach(() => {
  delete process.env.DEV_EMAIL_OVERRIDE;
});

describe("reading the row", () => {
  it("knows a next step by its policy, and reads what the decision wrote", () => {
    expect(isNextStepRow(step())).toBe(true);
    expect(isNextStepRow({ policyKey: "job.decision_pending" })).toBe(false);
    expect(nextStepOf(step())).toEqual({
      decisionId: 4,
      dueAt: new Date("2026-10-20T07:30:00Z"),
      jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
      nextStep: "Pay the invoice\nand file the receipt",
      outcome: "approve",
      ownerRole: null,
      ownerUserId: 9,
      rationale: "The lighting was ordered twice and the first order was paid.",
      requestId: 7,
      respondedBy: "Dee",
    });
  });

  it("reads nothing from a row that is not a next step, or whose context is not what a decision writes", () => {
    expect(nextStepOf(step({ policyKey: "job.manual" }))).toBeNull();
    expect(nextStepOf(step({ context: null }))).toBeNull();
    expect(nextStepOf(step({ context: { nextStep: { decisionId: "4" } } }))).toBeNull();
    expect(nextStepOf(step({ context: { nextStep: { decisionId: 4 } } }))).toBeNull();
  });

  it("reads a step for a role, and falls back to blanks for the optional parts", () => {
    const forRole = nextStepOf(step({ context: { nextStep: { decisionId: 4, nextStep: "Pay it", ownerRole: "accounts" } } }));
    expect(forRole).toMatchObject({ dueAt: null, jobLabel: null, outcome: "", ownerRole: "accounts", ownerUserId: null, rationale: "", requestId: 0, respondedBy: "" });
  });

  it("reads whose ladder it is: the role, and the person if one", () => {
    expect(ladderOf(step().context)).toEqual({ role: "accounts", userId: 9 });
    expect(ladderOf({ ladder: { role: " Accounts_Manager ", userId: null } })).toEqual({ role: "accounts_manager", userId: null });
    expect(ladderOf({ ladder: { role: "facilities", userId: 1.5 } })).toEqual({ role: "facilities", userId: null });
  });

  it("reads no ladder from a row without one, or with a broken one", () => {
    expect(ladderOf(null)).toBeNull();
    expect(ladderOf({})).toBeNull();
    expect(ladderOf({ ladder: { role: "" } })).toBeNull();
    expect(ladderOf({ ladder: { role: 4 } })).toBeNull();
    expect(ladderOf({ ladder: "accounts" })).toBeNull();
  });
});

describe("what the inbox offers", () => {
  it("the person it was handed to sees it and may push it further up, but not acknowledge, resolve or withdraw it", () => {
    const row = step();
    expect(canSee(viewer(ALANA), row)).toBe(true);
    expect(canAct(viewer(ALANA), row)).toBe(true);
    expect(availableActions(viewer(ALANA), row)).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: false });
  });

  it("the person who handed it on sees it and may push it further, but cannot take it back from here, though anyone else could", () => {
    const row = step();
    expect(canSee(viewer(DEE), row)).toBe(true);
    expect(canWithdraw(viewer(DEE), row)).toBe(true); // the generic rule, which the buttons override
    expect(availableActions(viewer(DEE), row)).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: false });
  });

  it("offers nothing to end it to a director or admin who is only overseeing", () => {
    for (const oversight of [ELI, { ...ELI, role: "admin", userId: 99 }]) {
      const actions = availableActions(viewer(oversight), step());
      expect(actions.acknowledge).toBe(false);
      expect(actions.resolve).toBe(false);
      expect(actions.withdraw).toBe(false);
    }
  });

  it("still offers an ordinary attention escalation everything it always did, so the difference is the step's", () => {
    const manual = step({ context: null, policyKey: "job.manual" });
    expect(availableActions(viewer(ALANA), manual)).toEqual({ acknowledge: true, escalateFurther: true, resolve: true, withdraw: false });
    expect(availableActions(viewer(DEE), manual)).toMatchObject({ withdraw: true });
  });

  it("is the owner's manager's to see once it has moved up, and they may act on it", () => {
    const row = movedUp();
    expect(canSee(viewer(CAM), row)).toBe(true);
    expect(canAct(viewer(CAM), row)).toBe(true);
    expect(availableActions(viewer(CAM), row)).toMatchObject({ acknowledge: false, resolve: false });
  });

  it("goes out in the DTO with the same actions, and the deep link to the job's decision (J6)", () => {
    const dto = toDto(step(), viewer(ALANA), NOW, USERS);
    expect(dto).toMatchObject({ deepLink: "/jobs?jobId=12&step=decision&decisionRequestId=7#decision", kind: "attention", policyKey: "job.next_step", targetUserName: "Alana" });
    expect(dto.actions).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: false });
  });
});

describe("who is emailed", () => {
  it("the owner, at their own level, and never the person who handed it on", () => {
    expect(targetUsers(step(), USERS).map((u) => u.name)).toEqual(["Alana"]);
  });

  it("the owner's manager once it moves up, by role, and not the owner even if they held that role", () => {
    expect(targetUsers(movedUp(), USERS).map((u) => u.name)).toEqual(["Cam", "Kirstin"]);
    const directorStep = step({
      context: { ladder: { role: "director", userId: DEE.userId }, nextStep: { ...nextStep, ownerUserId: DEE.userId }, userTargets: [DEE.userId] },
      raisedByUserId: ELI.userId,
      raisedByName: "Eli",
      targetRole: "director",
      targetUserId: DEE.userId,
    });
    expect(targetUsers(directorStep, USERS).map((u) => u.name)).toEqual(["Dee"]);
    const directorStepUp = { ...directorStep, level: 2, parentEscalationId: 42, targetRole: "director", targetUserId: null } as EscalationRow;
    expect(targetUsers(directorStepUp, [...USERS, { ...ELI, userId: 7, name: "Fran" }]).map((u) => u.name)).toEqual(["Eli", "Fran"]);
  });

  it("the person who handed it on is told when it moves up if they are the manager it moves up to, so a lone manager is not left with nobody emailed", () => {
    const byCam = movedUp({ raisedByName: "Cam", raisedByUserId: CAM.userId });
    expect(targetUsers(byCam, USERS).map((u) => u.name)).toEqual(["Cam", "Kirstin"]);
    expect(targetUsers(byCam, [CAM, ALANA]).map((u) => u.name)).toEqual(["Cam"]);
    expect(targetUsers(step({ raisedByName: "Cam", raisedByUserId: CAM.userId }), USERS).map((u) => u.name)).toEqual(["Alana"]);
  });

  it("but not at the owner's own level, when they handed the step to themselves", () => {
    const toSelf = step({
      context: { ladder: { role: "accounts_manager", userId: CAM.userId }, nextStep: { ...nextStep, ownerUserId: CAM.userId }, userTargets: [CAM.userId] },
      raisedByName: "Cam",
      raisedByUserId: CAM.userId,
      targetRole: "accounts_manager",
      targetUserId: CAM.userId,
    });
    expect(targetUsers(toSelf, USERS)).toEqual([]);
  });

  it("every address rewritten to the override when DEV_EMAIL_OVERRIDE is set", () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";
    expect(targetAddresses(step(), USERS, ENV)).toEqual(["dev@example.com"]);
  });

  it("a step for a whole role goes to everyone who holds it, named in its context", () => {
    const forRole = step({
      context: { ladder: { role: "accounts", userId: null }, nextStep: { ...nextStep, ownerRole: "accounts", ownerUserId: null }, userTargets: [ALANA.userId, GUS.userId] },
      targetRole: null,
      targetUserId: null,
    });
    expect(targetUsers(forRole, USERS).map((u) => u.name)).toEqual(["Alana", "Gus"]);
  });

  it("sends the owner one email: what was decided, why, what to do, when, and the link", async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const options: NotifyOptions = { env: ENV, now: () => NOW, sendMail, users: USERS };

    const outcome = await notifyTargets(conn, step(), "raise", options);

    expect(outcome).toMatchObject({ recipients: ["alana@example.com"], state: "sent" });
    const [to, subject, body] = sendMail.mock.calls[0];
    expect(to).toEqual(["alana@example.com"]);
    expect(subject).toBe("Next step for you: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(body).toContain("Dee has decided on a job and handed the next step to you.");
    expect(body).toContain("Decision: Approved by Dee");
    expect(body).toContain("Why: The lighting was ordered twice and the first order was paid.");
    expect(body).toContain("Next step: Pay the invoice\nand file the receipt");
    expect(body).toContain("Due: 20/10/2026 17:00 Darwin time");
    expect(body).toContain("Open it in Floorplan: https://floorplan.example/jobs?jobId=12");
  });

  it("tells nobody, and says so, when the owner is the person who handed it on: they know", async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const selfAssigned = step({ context: { ...step().context, ladder: { role: "director", userId: DEE.userId }, userTargets: [DEE.userId] }, targetRole: "director", targetUserId: DEE.userId });

    const outcome = await notifyTargets(conn, selfAssigned, "raise", { env: ENV, now: () => NOW, sendMail, users: USERS });

    expect(sendMail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ recipients: [], state: "none" });
  });
});

describe("the next step's emails", () => {
  const build = (kind: Parameters<typeof buildNextStepEmail>[0], row: EscalationRow = step(), owned: string[] = ["Alana"]) => buildNextStepEmail(kind, row, LINK, owned);

  it("tells the owner at the start: urgent if the request was", () => {
    expect(build("raise")?.subject).toBe("Next step for you: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(build("raise", step({ urgent: true }))?.subject).toBe("URGENT next step for you: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
  });

  it("says a revision is passed back, with the changes to make", () => {
    const revise = step({ context: { ...step().context, nextStep: { ...nextStep, nextStep: "Correct the ABN and resubmit", outcome: "revise" } } });
    const email = build("raise", revise);
    expect(email?.subject).toBe("Revisions requested: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(email?.body).toContain("Dee has asked for changes and passed the job back for the next step.");
    expect(email?.body).toContain("Decision: Revisions requested by Dee");
    expect(email?.body).toContain("Next step: Correct the ABN and resubmit");
  });

  it("says it was handed to a role, when it was", () => {
    const forRole = step({ context: { nextStep: { ...nextStep, ownerRole: "accounts", ownerUserId: null } } });
    expect(build("raise", forRole)?.body).toContain("handed the next step to the Accounts role.");
  });

  it("reminds, then says it is overdue and has moved up to the manager, naming who has it", () => {
    expect(build("reminder")?.subject).toBe("Reminder, next step due: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(build("reminder")?.body).toContain("A next step is still waiting for you.");
    const up = build("supersede", movedUp());
    expect(up?.subject).toBe("Next step overdue, escalated to you: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(up?.body).toContain("has been escalated to you. You may need to chase Alana.");
    expect(up?.body).toContain("With: Alana");
    expect(build("supersede", movedUp({ urgent: true }))?.subject).toMatch(/^URGENT next step overdue/);
  });

  it("tells the level it left that it has moved up, and that it still needs doing", () => {
    const email = build("fyi", movedUp());
    expect(email?.subject).toMatch(/^FYI, next step escalated:/);
    expect(email?.body).toContain("escalated to Accounts manager. It still needs doing.");
  });

  it("says it is done, without a due date", () => {
    const email = build("resolved");
    expect(email?.subject).toMatch(/^Next step done:/);
    expect(email?.body).toContain("This next step is done.");
    expect(email?.body).not.toContain("Due:");
  });

  it("says the step is marked done on the job, not by replying", () => {
    expect(build("raise")?.body).toContain("Mark the step done there, not by replying.");
  });

  it("clips a very long rationale and step, and falls back on the row's summary and a plain pointer with no link", () => {
    const long = step({ context: { nextStep: { ...nextStep, jobLabel: undefined, nextStep: "s".repeat(3000), rationale: "r".repeat(3000) } } });
    const email = buildNextStepEmail("raise", long, null, []);
    expect(email?.body).toContain(`Why: ${"r".repeat(600)}...`);
    expect(email?.body).toContain(`Next step: ${"s".repeat(1000)}...`);
    expect(email?.body).toContain("Open Floorplan to see it.");
    expect(email?.subject).toContain("Job #12 · Superseded lighting invoice");
  });

  it("is not the email for a row that is not a next step, and the notifier picks the right one", () => {
    expect(buildNextStepEmail("raise", step({ policyKey: "job.manual" }), LINK, [])).toBeNull();
    expect(buildEmail("raise", step(), LINK, ["Alana"]).subject).toMatch(/^Next step for you:/);
    expect(buildEmail("raise", step({ context: null, policyKey: "job.manual", urgent: false }), LINK).subject).toMatch(/^Escalation:/);
  });

  it("names the outcomes", () => {
    expect(["approve", "deny", "defer", "revise", "other"].map(outcomeLabel)).toEqual(["Approved", "Denied", "Deferred", "Revisions requested", "Decided"]);
  });
});

describe("a deferred question coming round again", () => {
  const reask = { askedBy: "Alana", decisionId: 4, deferredUntil: "2026-10-23" };
  const decision = {
    assignmentMode: "named",
    callThem: false,
    jobLabel: "Job #12 · Superseded lighting invoice",
    question: "Pay the superseded invoice?",
    reaskOf: reask,
    requestId: 9,
    respondBy: "2026-10-30T07:30:00.000Z",
    tier: "soon",
  };
  const again = (over: Partial<EscalationRow> = {}): EscalationRow =>
    step({
      context: { decision, userTargets: [CAM.userId, DEE.userId] },
      kind: "authority",
      policyKey: "job.decision_pending",
      raisedByKind: "system",
      raisedByName: "Floorplan",
      raisedByUserId: null,
      reason: "needs_decision",
      targetRole: null,
      targetUserId: null,
      ...over,
    });

  it("is read from the context: who first asked, which decision it follows and the day it was put off to", () => {
    expect(decisionOf(again())?.reaskOf).toEqual(reask);
    expect(decisionOf(again({ context: { decision: { ...decision, reaskOf: undefined }, userTargets: [3] } }))?.reaskOf).toBeNull();
    expect(decisionOf(again({ context: { decision: { ...decision, reaskOf: { decisionId: "4" } }, userTargets: [3] } }))?.reaskOf).toBeNull();
  });

  it("says so in the email, in the decision wording: due again, and who first asked", () => {
    const email = buildDecisionEmail("raise", again(), LINK, ["Cam", "Dee"]);
    expect(email?.subject).toBe("Decision due again: Job #12 · Superseded lighting invoice");
    expect(email?.body).toContain("A question that was put off until 23/10/2026 is due again. It was first asked by Alana.");
    expect(email?.body).toContain("Question: Pay the superseded invoice?");
    expect(email?.body).toContain("Raised by: Floorplan (automatic)");
    expect(email?.body).toContain("Asked of: Cam, Dee");
  });

  it("is urgent in the subject when it is", () => {
    expect(buildDecisionEmail("raise", again({ urgent: true }), LINK, [])?.subject).toMatch(/^URGENT decision due again:/);
  });

  it("leaves the wording of a first asking, and of a reminder or move-up on a re-ask, as it was", () => {
    const first = again({ context: { decision: { ...decision, reaskOf: undefined }, userTargets: [3, 5] }, raisedByKind: "user", raisedByName: "Alana" });
    expect(buildDecisionEmail("raise", first, LINK, [])?.subject).toBe("Decision needed: Job #12 · Superseded lighting invoice");
    expect(buildDecisionEmail("reminder", again(), LINK, [])?.subject).toBe("Reminder, decision needed: Job #12 · Superseded lighting invoice");
    expect(buildDecisionEmail("supersede", again(), LINK, [])?.body).toContain("A decision was not made by the time it was due");
  });
});
