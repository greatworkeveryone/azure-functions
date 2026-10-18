/// <reference types="jest" />
// A decision request goes to a group of named people: its row carries no role and no
// single person, so who it is for is the userTargets in its context. This pins each
// place that has to know: the inbox query, the permission checks, the emails, the
// morning digest's targeting and the DTO.
import type { Connection } from "tedious";
import "./adapters";
import { toDto } from "./dto";
import { availableActions, canAct, canSee, canWithdraw, isTargetOf } from "./permissions";
import { buildListWhere } from "./store";
import { buildEmail, notifyTargets, targetAddresses, targetUsers, type NotifyOptions } from "./notifier";
import type { DirectoryUser, EscalationRow, Viewer } from "./types";

// Escalation emails ask whether their subject is a test record (D9); none is here.
jest.mock("../test-data", () => ({ ...jest.requireActual("../test-data"), readIsTest: jest.fn().mockResolvedValue(false) }));
jest.mock("./store", () => ({
  ...jest.requireActual("./store"),
  listActiveUsers: jest.fn(),
  recordNotification: jest.fn().mockResolvedValue(undefined),
}));
const store = require("./store") as { recordNotification: jest.Mock };

const conn = {} as Connection;
const NOW = new Date("2026-10-13T01:00:00Z");

const user = (userId: number, name: string, role: string, email: string | null = `${name.toLowerCase()}@example.com`): DirectoryUser => ({ email, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const ADA = user(7, "Ada", "admin");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const GUS = user(10, "Gus", "accounts");
const USERS = [CAM, DEE, ELI, ADA, FAY, ALANA, GUS];

const ENV = {
  APP_BASE_URL: "https://floorplan.example",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
} as NodeJS.ProcessEnv;

const viewer = (u: DirectoryUser, roles: string[] = [u.role]): Viewer => ({ name: u.name, roles, userId: u.userId });

const decision = {
  assignmentMode: "named",
  callThem: false,
  jobLabel: "Job #12 · Superseded lighting invoice",
  question: "Pay the superseded invoice?",
  requestId: 7,
  respondBy: "2026-10-20T07:30:00.000Z",
  tier: "soon",
};

/** A pending decision request asked of Cam and Dee by Alana. */
function request(over: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: { decision, userTargets: [CAM.userId, DEE.userId] },
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
    raisedByName: "Alana",
    raisedByUserId: ALANA.userId,
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
    summary: "Job #12 · Superseded lighting invoice — Decision needed: Pay the superseded invoice?",
    targetRole: null,
    targetUserId: null,
    updatedAt: new Date("2026-10-12T00:00:00Z"),
    urgent: false,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  store.recordNotification.mockResolvedValue(undefined);
  delete process.env.DEV_EMAIL_OVERRIDE;
});
afterEach(() => {
  delete process.env.DEV_EMAIL_OVERRIDE;
});

describe("the inbox query", () => {
  const where = (view: "mine" | "visible" | "raised" | "team" | "all", u: DirectoryUser) =>
    buildListWhere({ status: "active", view, viewer: viewer(u) });

  it("shows a person the requests they were named in, in the For me view", () => {
    const { params, whereSql } = where("mine", CAM);

    expect(whereSql).toContain("e.TargetRole IS NULL AND e.NoIndependentTarget = 0 AND EXISTS");
    expect(whereSql).toContain("OPENJSON(ISNULL(e.Context, N'{}'), N'$.userTargets')");
    expect(whereSql).toContain("TRY_CONVERT(INT, t.[value]) = @ViewerUserId");
    expect(params).toContainEqual(expect.objectContaining({ name: "ViewerUserId", value: CAM.userId }));
  });

  it("keeps the role and named-person rules the view already had", () => {
    const { whereSql } = where("mine", CAM);
    expect(whereSql).toContain("e.TargetUserId = @ViewerUserId");
    expect(whereSql).toContain("e.TargetUserId IS NULL AND e.TargetRole IN (@MineRole0)");
  });

  it("shows it in the everything-I-may-see view too", () => {
    expect(where("visible", CAM).whereSql).toContain("OPENJSON(ISNULL(e.Context, N'{}'), N'$.userTargets')");
  });

  it("is not part of the views it has no place in", () => {
    for (const view of ["raised", "all"] as const) {
      expect(where(view, CAM).whereSql).not.toContain("OPENJSON");
    }
  });

  it("binds the person, never writes them into the text", () => {
    const { whereSql } = where("mine", CAM);
    expect(whereSql).not.toContain(String(CAM.userId));
    expect(whereSql).not.toMatch(/Cam/);
  });
});

describe("who may see and do what with it", () => {
  it("each person named is a target, and may see it and act on it; a colleague who was not named may not", () => {
    for (const u of [CAM, DEE]) {
      expect(isTargetOf(viewer(u), request())).toBe(true);
      expect(canSee(viewer(u), request())).toBe(true);
      expect(canAct(viewer(u), request())).toBe(true);
    }
    for (const u of [FAY, GUS]) {
      expect(isTargetOf(viewer(u), request())).toBe(false);
      expect(canSee(viewer(u), request())).toBe(false);
      expect(canAct(viewer(u), request())).toBe(false);
    }
  });

  it("directors and admin who were not named still see it, as oversight", () => {
    expect(canSee(viewer(ELI), request())).toBe(true);
    expect(canSee(viewer(ADA), request())).toBe(true);
    expect(canAct(viewer(ELI), request())).toBe(true);
  });

  it("the person who asked sees it and cannot act on it", () => {
    expect(canSee(viewer(ALANA), request())).toBe(true);
    expect(canAct(viewer(ALANA), request())).toBe(false);
  });

  it("stays visible to the others once a colleague has acknowledged it", () => {
    const claimed = request({ acknowledgedAt: NOW, acknowledgedByName: "Cam", acknowledgedByUserId: CAM.userId, status: "acknowledged", targetUserId: CAM.userId });
    expect(canSee(viewer(DEE), claimed)).toBe(true);
    expect(isTargetOf(viewer(DEE), claimed)).toBe(true);
  });

  it("is no longer the named people's once it has moved up to a role", () => {
    const movedUp = request({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" });
    expect(isTargetOf(viewer(DEE), movedUp)).toBe(false);
    expect(isTargetOf(viewer(CAM), movedUp)).toBe(true); // by role, as usual
    expect(canSee(viewer(DEE), movedUp)).toBe(true); // a director sees what is aimed below them
    expect(canSee(viewer(FAY), movedUp)).toBe(false);
  });

  it("offers no acknowledge and no withdraw from the inbox, and no resolve: it is answered, or withdrawn from the request", () => {
    expect(availableActions(viewer(CAM), request())).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: false });
    expect(availableActions(viewer(ALANA), request())).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: false });
    // the raiser could withdraw an ordinary escalation; the permission alone has not changed
    expect(canWithdraw(viewer(ALANA), request())).toBe(true);
  });

  it("still offers an ordinary open escalation everything it did", () => {
    const ordinary = request({ context: null, kind: "attention", policyKey: "job.manual", targetRole: "accounts_manager" });
    expect(availableActions(viewer(CAM), ordinary)).toEqual({ acknowledge: true, escalateFurther: true, resolve: true, withdraw: false });
    expect(availableActions(viewer(ALANA), ordinary)).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: true });
  });
});

describe("who is emailed", () => {
  it("each person named, and no one else", () => {
    expect(targetUsers(request(), USERS).map((u) => u.name)).toEqual(["Cam", "Dee"]);
    expect(targetAddresses(request(), USERS, ENV)).toEqual(["cam@example.com", "dee@example.com"]);
  });

  it("never the person who asked, even if named, nor anyone the row excludes", () => {
    const named = request({ context: { decision, excludeUserIds: [DEE.userId], userTargets: [CAM.userId, DEE.userId, ALANA.userId] } });
    expect(targetUsers(named, USERS).map((u) => u.name)).toEqual(["Cam"]);
  });

  it("leaves out a named person who is no longer active", () => {
    expect(targetUsers(request(), [CAM, ELI]).map((u) => u.name)).toEqual(["Cam"]);
  });

  it("is the claimant alone once somebody has acknowledged it (the rule for any named person)", () => {
    const claimed = request({ acknowledgedByUserId: DEE.userId, status: "acknowledged", targetUserId: DEE.userId });
    expect(targetUsers(claimed, USERS).map((u) => u.name)).toEqual(["Dee"]);
  });

  it("is the manager's level, by role, once it has moved up", () => {
    const movedUp = request({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" });
    expect(targetUsers(movedUp, USERS).map((u) => u.name)).toEqual(["Cam"]);
  });

  it("is every address rewritten to the override, once, when DEV_EMAIL_OVERRIDE is set", () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";
    expect(targetAddresses(request(), USERS, ENV)).toEqual(["dev@example.com"]);
  });

  it("sends one email to every person named, with the question, the job and who else was asked", async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const options: NotifyOptions = { env: ENV, now: () => NOW, sendMail, users: USERS };

    const outcome = await notifyTargets(conn, request(), "raise", options);

    expect(outcome).toMatchObject({ recipients: ["cam@example.com", "dee@example.com"], state: "sent" });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [to, subject, body] = sendMail.mock.calls[0];
    expect(to).toEqual(["cam@example.com", "dee@example.com"]);
    expect(subject).toBe("Decision needed: Job #12 · Superseded lighting invoice");
    expect(body).toContain("Question: Pay the superseded invoice?");
    expect(body).toContain("Asked of: Cam, Dee");
    expect(body).toContain("Respond by: 20/10/2026 17:00 Darwin time");
    expect(body).toContain("Open it in Floorplan: https://floorplan.example/jobs?jobId=12");
  });

  it("sends it to the override address alone in dev, and still says who was asked", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";
    const sendMail = jest.fn().mockResolvedValue(undefined);

    await notifyTargets(conn, request(), "raise", { env: ENV, now: () => NOW, sendMail, users: USERS });

    expect(sendMail.mock.calls[0][0]).toEqual(["dev@example.com"]);
    expect(sendMail.mock.calls[0][2]).toContain("Asked of: Cam, Dee");
  });

  it("builds the email for a row whose people are named in its context, whatever level it is at", () => {
    const movedUp = request({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" });
    expect(buildEmail("supersede", movedUp, "https://floorplan.example/jobs?jobId=12", ["Cam", "Dee"]).body).toContain("Asked of: Cam, Dee");
  });
});

describe("what a send costs the row", () => {
  const send = (over: Partial<NotifyOptions> = {}, fail = false) =>
    notifyTargets(conn, request(), "reminder", {
      env: ENV,
      now: () => NOW,
      sendMail: fail ? jest.fn().mockRejectedValue(new Error("503")) : jest.fn().mockResolvedValue(undefined),
      sleep: jest.fn().mockResolvedValue(undefined),
      users: USERS,
      ...over,
    });
  const recorded = () => store.recordNotification.mock.calls.map((c) => ({ attempts: c[3], state: c[2].state }));

  it("counts every try by default, as it always has", async () => {
    await send();
    expect(recorded()).toEqual([{ attempts: 1, state: "sent" }]);
  });

  it("counts nothing for a reminder that got through when asked to count failures only", async () => {
    await send({ countAttempts: "failures" });
    expect(recorded()).toEqual([{ attempts: 0, state: "sent" }]);
  });

  it("counts every try of a reminder that failed, so the retry limit still works", async () => {
    await send({ attempts: 3, countAttempts: "failures" }, true);
    expect(recorded()).toEqual([{ attempts: 3, state: "failed" }]);
  });
});

describe("the DTO", () => {
  const dir = USERS;

  it("names the people a row goes to when its level is a group of them", () => {
    expect(toDto(request(), viewer(CAM), NOW, dir)).toMatchObject({ kind: "authority", targetNames: ["Cam", "Dee"], targetRole: null, targetUserId: null });
  });

  it("labels such a row with the people, not with 'Nobody'", () => {
    expect(toDto(request(), viewer(CAM), NOW, dir).targetRoleLabel).toBe("Cam, Dee");
    const many = request({ context: { decision, userTargets: [3, 5, 6, 7, 8] } });
    expect(toDto(many, viewer(CAM), NOW, dir).targetRoleLabel).toBe("Cam, Dee, Eli +2 more");
    expect(toDto(many, viewer(CAM), NOW, dir).targetNames).toEqual(["Cam", "Dee", "Eli", "Ada", "Fay"]);
  });

  it("keeps the role's label for a row that has one", () => {
    expect(toDto(request({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" }), viewer(CAM), NOW, dir).targetRoleLabel).toBe("Accounts manager");
    expect(toDto(request({ context: null, targetRole: null }), viewer(CAM), NOW, dir).targetRoleLabel).toBe("Nobody");
  });

  it("names nobody for a row with a role, or one person", () => {
    expect(toDto(request({ level: 2, parentEscalationId: 41, targetRole: "accounts_manager" }), viewer(CAM), NOW, dir).targetNames).toEqual([]);
    expect(toDto(request({ context: null, targetRole: "accounts_manager", targetUserId: CAM.userId }), viewer(CAM), NOW, dir).targetNames).toEqual([]);
  });

  it("skips someone who is not in the directory rather than showing a blank", () => {
    expect(toDto(request(), viewer(CAM), NOW, [CAM]).targetNames).toEqual(["Cam"]);
  });

  it("shows the actions the viewer has, and the deep link to the job", () => {
    const dto = toDto(request(), viewer(CAM), NOW, dir);
    expect(dto.actions).toEqual({ acknowledge: false, escalateFurther: true, resolve: false, withdraw: false });
    expect(dto.deepLink).toBe("/jobs?jobId=12");
    expect(dto.context).toMatchObject({ decision: { requestId: 7 }, userTargets: [3, 5] });
  });
});
