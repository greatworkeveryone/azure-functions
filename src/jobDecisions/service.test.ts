/// <reference types="jest" />
// Asking for a decision and taking the question back, as one transaction each
// (jobs plan A1). The SQL layer runs for real against a small in-memory stand-in
// for the database; the escalation engine and the ledger are replaced, because
// they have their own tests: what is proved here is the order of the writes, that
// they commit or roll back together, and that nothing is emailed before the commit.
import type { Connection } from "tedious";
import { raiseWithin, withdrawWithin } from "../escalation/engine";
import type { EscalationRow } from "../escalation/types";
import { record } from "../ledger";
import { RequestError, parseRequestBody } from "./request";
import { requestDecision, withdrawDecision, type UserActor } from "./service";
import { TierError, type TierRequest } from "./tiers";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger", () => ({ ...jest.requireActual("../ledger"), record: jest.fn() }));
jest.mock("../escalation/engine", () => ({ raiseWithin: jest.fn(), withdrawWithin: jest.fn() }));

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const raise = jest.mocked(raiseWithin);
const withdrawEscalation = jest.mocked(withdrawWithin);
const ledger = jest.mocked(record);

const conn = {} as Connection;
// Monday 2026-10-12, 09:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);
const HOLIDAYS = new Set<string>();

type Row = Record<string, unknown>;
const user = (UserID: number, DisplayName: string, Role: string): Row => ({ DisplayName, Email: `${DisplayName.toLowerCase()}@example.com`, IsActive: true, Role, UserID });
const USERS = [user(3, "Cam", "accounts_manager"), user(4, "Kirstin", "accounts_manager"), user(5, "Dee", "director"), user(6, "Eli", "director"), user(9, "Alana", "accounts"), user(20, "Una", "user")];

const alana: UserActor = { kind: "user", name: "Alana", role: "accounts", userId: 9 };
const ctx = (over: Record<string, unknown> = {}) => ({ actor: alana, holidays: HOLIDAYS, now: NOW, ...over });

interface World {
  attachments: Set<number>;
  events: string[];
  insertError: Error | null;
  job: Row | null;
  live: Row | null;
  requests: Row[];
}
let world: World;

const rowVersion = (n: number): Buffer => Buffer.from([0, 0, 0, 0, 0, 0, 0, n]);

function installDatabase(): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    const text = sql.replace(/\s+/g, " ");
    if (/FROM dbo\.Jobs j WITH \(UPDLOCK, HOLDLOCK\)/.test(text)) return world.job ? [world.job] : [];
    if (/SELECT BuildingID FROM dbo\.Jobs WHERE JobID/.test(text)) return world.job ? [{ BuildingID: world.job.BuildingID }] : [];
    if (/FROM dbo\.Attachments WHERE Id = @AttachmentId AND JobID = @JobID/.test(text)) return world.attachments.has(p.AttachmentId as number) ? [{ Id: p.AttachmentId }] : [];
    if (/FROM dbo\.AppUsers WHERE IsActive = 1/.test(text)) return USERS;
    if (/FROM dbo\.JobDecisionRequests WHERE JobId = @JobId AND State = N'pending'/.test(text)) {
      return world.requests.filter((r) => r.JobId === p.JobId && r.State === "pending");
    }
    if (/INSERT INTO dbo\.JobDecisionRequests/.test(text)) {
      world.events.push("insert request");
      if (world.insertError) throw world.insertError;
      const RequestId = 7 + world.requests.length;
      world.requests.push({
        AssignmentMode: p.AssignmentMode, AutoEscalate: p.AutoEscalate, DecisionMakers: p.DecisionMakers, JobId: p.JobId, Question: p.Question, RequestId, RequestedAt: NOW,
        RequestedBy: p.RequestedBy, RequestedByUserId: p.RequestedByUserId, RespondBy: p.RespondBy, RoutineWeeks: p.RoutineWeeks, RowVersion: rowVersion(1),
        SourceAttachmentId: p.SourceAttachmentId, State: "pending", Tier: p.Tier, WithdrawnAt: null, WithdrawnBy: null, WithdrawnByUserId: null, WithdrawnReason: null,
      });
      return [{ RequestId }];
    }
    if (/FROM dbo\.JobDecisionRequests (WITH \(UPDLOCK, ROWLOCK\) )?WHERE RequestId = @RequestId/.test(text)) {
      return world.requests.filter((r) => r.RequestId === p.RequestId);
    }
    if (/UPDATE dbo\.JobDecisionRequests SET State = N'withdrawn'/.test(text)) {
      world.events.push("mark withdrawn");
      const found = world.requests.find((r) => r.RequestId === p.RequestId && r.State === "pending" && (!("RowVersion" in p) || (p.RowVersion as Buffer).equals(r.RowVersion as Buffer)));
      if (!found) return [];
      Object.assign(found, { RowVersion: rowVersion(2), State: "withdrawn", WithdrawnAt: p.At, WithdrawnBy: p.By, WithdrawnByUserId: p.ById, WithdrawnReason: p.Reason });
      return [{ RequestId: found.RequestId }];
    }
    if (/FROM dbo\.Escalations\s+WHERE SubjectType = @SubjectType/.test(text)) return world.live ? [world.live] : [];
    throw new Error(`unexpected SQL: ${text}`);
  });
}

const ESC = {
  buildingId: 5,
  context: null,
  createdAt: NOW,
  dueAt: null,
  escalationId: 100,
  kind: "authority",
  level: 1,
  notificationState: "sent",
  parentEscalationId: null,
  policyKey: "job.decision_pending",
  status: "open",
  subjectId: "12",
  subjectType: "job",
  targetRole: null,
  urgent: false,
} as unknown as EscalationRow;

const liveRow = (over: Record<string, unknown> = {}): Row => ({
  AcknowledgedAt: null, BuildingId: 5, Context: null, CreatedAt: NOW, DueAt: null, EscalationId: 100, Kind: "authority", Level: 1, NotificationState: "sent",
  PolicyKey: "job.decision_pending", RaisedByKind: "user", RaisedByName: "Alana", RowVersion: rowVersion(3), Status: "open", SubjectId: "12", SubjectType: "job",
  Summary: "Job #12", TargetRole: null, Urgent: false, UpdatedAt: NOW, ...over,
});

const body = (over: Record<string, unknown> = {}) =>
  parseRequestBody({
    assignmentMode: "named",
    decisionMakers: { userIds: [3, 5] },
    jobId: 12,
    question: "Pay the superseded lighting invoice?",
    tier: "soon",
    ...over,
  });

const adminJob = (over: Row = {}): Row => ({
  BuildingID: 5, BuildingName: "25 Temira Crescent", IsArchived: false, JobID: 12, Kind: "admin", Status: "New", Title: "Superseded lighting invoice", ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  world = { attachments: new Set([77]), events: [], insertError: null, job: adminJob(), live: null, requests: [] };
  installDatabase();
  db.beginTransaction.mockImplementation(async () => world.events.push("begin"));
  db.commitTransaction.mockImplementation(async () => world.events.push("commit"));
  db.rollbackTransaction.mockImplementation(async () => world.events.push("rollback"));
  ledger.mockImplementation(async (_c, entry) => {
    world.events.push(`ledger:${entry.action}`);
  });
  raise.mockImplementation((async () => {
    world.events.push("raise");
    return {
      announce: async () => {
        world.events.push("announce");
        return ESC;
      },
      created: true,
      escalation: ESC,
    };
  }) as never);
  withdrawEscalation.mockImplementation((async () => {
    world.events.push("withdraw escalation");
    return ESC;
  }) as never);
});

const writes = () => world.events.filter((e) => e !== "begin" && e !== "commit" && e !== "rollback");

// ── ask ──────────────────────────────────────────────────────────────────────

describe("requestDecision", () => {
  it("writes the request, raises the escalation and ledgers it in one transaction, then emails after the commit", async () => {
    const outcome = await requestDecision(conn, ctx(), body());

    expect(world.events).toEqual(["begin", "insert request", "raise", "ledger:decision.requested", "commit", "announce"]);
    expect(outcome.request).toMatchObject({ jobId: 12, requestId: 7, state: "pending", tier: "soon" });
    expect(outcome.chase).toBe(ESC);
  });

  it("raises the policy on the job with the people asked, the tier's due moment and the request it belongs to", async () => {
    await requestDecision(conn, ctx(), body());

    expect(raise).toHaveBeenCalledTimes(1);
    const [connection, input] = raise.mock.calls[0];
    expect(connection).toBe(conn);
    expect(input).toMatchObject({
      actor: alana,
      dueAt: new Date("2026-10-19T07:30:00Z"), // soon: next Monday, 17:00 Darwin
      headline: "Decision needed: Pay the superseded lighting invoice?",
      note: "Pay the superseded lighting invoice?",
      now: NOW,
      policyKey: "job.decision_pending",
      reason: "needs_decision",
      subjectId: "12",
      subjectType: "job",
      urgent: false,
      userTargets: [3, 5],
    });
    expect(input.notify).toEqual({ attempts: 1 });
    expect(input.context).toEqual({
      decision: {
        assignmentMode: "named",
        autoEscalate: true,
        callThem: false,
        jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
        question: "Pay the superseded lighting invoice?",
        requestId: 7,
        respondBy: "2026-10-19T07:30:00.000Z",
        tier: "soon",
      },
      schedule: { escalateAt: "2026-10-19T07:30:00.000Z", remindAt: ["2026-10-15T23:00:00.000Z"] },
    });
  });

  it("stores the request: who was asked, when it is due, who asked", async () => {
    await requestDecision(conn, ctx(), body({ sourceAttachmentId: 77 }));

    expect(world.requests).toHaveLength(1);
    expect(world.requests[0]).toMatchObject({
      AssignmentMode: "named",
      AutoEscalate: true,
      JobId: 12,
      Question: "Pay the superseded lighting invoice?",
      RequestedBy: "Alana",
      RequestedByUserId: 9,
      RespondBy: new Date("2026-10-19T07:30:00Z"),
      RoutineWeeks: null,
      SourceAttachmentId: 77,
      Tier: "soon",
    });
    expect(JSON.parse(world.requests[0].DecisionMakers as string)).toEqual({ role: null, userIds: [3, 5] });
  });

  it("ledgers decision.requested on the job with the request as 'after', under the id the escalation's row shares", async () => {
    await requestDecision(conn, ctx(), body());

    expect(ledger).toHaveBeenCalledTimes(1);
    const entry = ledger.mock.calls[0][1];
    expect(entry).toMatchObject({
      action: "decision.requested",
      actor: alana,
      buildingId: 5,
      jobId: 12,
      ruleApplied: "decision_request.soon",
      subject: { id: 12, type: "job" },
    });
    expect(entry.after).toMatchObject({
      assignmentMode: "named",
      autoEscalate: true,
      callThem: false,
      decisionMakers: { role: null, userIds: [3, 5] },
      escalateAt: "2026-10-19T07:30:00.000Z",
      question: "Pay the superseded lighting invoice?",
      remindAt: ["2026-10-15T23:00:00.000Z"],
      requestId: 7,
      respondBy: "2026-10-19T07:30:00.000Z",
      state: "pending",
      tier: "soon",
    });
    expect(entry.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(raise.mock.calls[0][1].correlationId).toBe(entry.correlationId);
    expect(ledger.mock.calls[0][0]).toBe(conn);
  });

  it("asks everyone in a role: the people at the time, the role recorded", async () => {
    await requestDecision(conn, ctx(), body({ assignmentMode: "role", decisionMakers: { role: "accounts_manager" } }));

    expect(raise.mock.calls[0][1].userTargets).toEqual([3, 4]);
    expect(raise.mock.calls[0][1].context).toMatchObject({ decision: { assignmentMode: "role" } });
    expect(world.requests[0]).toMatchObject({ AssignmentMode: "role" });
    expect(JSON.parse(world.requests[0].DecisionMakers as string)).toEqual({ role: "accounts_manager", userIds: [3, 4] });
    expect(ledger.mock.calls[0][1].after).toMatchObject({ assignmentMode: "role", decisionMakers: { role: "accounts_manager", userIds: [3, 4] } });
  });

  describe("the tiers", () => {
    it("urgent, ticked to move up: raised urgent, one reminder at 24 hours, moved up the next business morning after the respond-by", async () => {
      const outcome = await requestDecision(conn, ctx(), body({ autoEscalate: true, tier: "urgent" }));

      const input = raise.mock.calls[0][1];
      expect(input.urgent).toBe(true);
      expect(world.requests[0]).toMatchObject({ AutoEscalate: true, Tier: "urgent" });
      expect(world.requests[0].RespondBy).toEqual(new Date("2026-10-13T07:30:00Z")); // Tue 13 Oct 17:00 Darwin
      expect(input.context).toMatchObject({
        decision: { autoEscalate: true },
        schedule: { escalateAt: "2026-10-13T23:00:00.000Z", remindAt: ["2026-10-12T23:30:00.000Z"] }, // Tue 13 Oct 09:00 Darwin
      });
      expect(input.dueAt).toEqual(new Date("2026-10-13T23:00:00Z")); // Wed 14 Oct 08:30 Darwin
      expect(outcome.request.autoEscalate).toBe(true);
      expect(outcome.schedule).toMatchObject({ autoEscalate: true, urgent: true });
      expect(ledger.mock.calls[0][1].after).toMatchObject({ autoEscalate: true, escalateAt: "2026-10-13T23:00:00.000Z" });
    });

    it.each([[{}], [{ autoEscalate: false }], [{ autoEscalate: null }]])(
      "urgent, not ticked (%j, the default): same deadline and 24-hour reminder, but no due moment, so the engine never moves it up",
      async (extra) => {
        const outcome = await requestDecision(conn, ctx(), body({ tier: "urgent", ...extra }));

        const input = raise.mock.calls[0][1];
        expect(input.urgent).toBe(true);
        expect(input.dueAt).toBeNull();
        expect(input.context).toMatchObject({
          decision: { autoEscalate: false, respondBy: "2026-10-13T07:30:00.000Z" },
          schedule: { escalateAt: null, remindAt: ["2026-10-12T23:30:00.000Z"] },
        });
        expect(world.requests[0]).toMatchObject({ AutoEscalate: false, RespondBy: new Date("2026-10-13T07:30:00Z"), Tier: "urgent" });
        expect(outcome.request.autoEscalate).toBe(false);
        expect(outcome.schedule).toMatchObject({ autoEscalate: false, escalateAt: null, urgent: true });
        expect(ledger.mock.calls[0][1].after).toMatchObject({ autoEscalate: false, escalateAt: null, remindAt: ["2026-10-12T23:30:00.000Z"] });
        expect(world.events).toEqual(["begin", "insert request", "raise", "ledger:decision.requested", "commit", "announce"]);
      },
    );

    it("routine: the weeks are kept on the request", async () => {
      await requestDecision(conn, ctx(), body({ routineWeeks: 3, tier: "routine" }));
      expect(world.requests[0]).toMatchObject({ AutoEscalate: true, RoutineWeeks: 3, Tier: "routine" });
      expect(raise.mock.calls[0][1].dueAt).toEqual(new Date("2026-11-02T07:30:00Z"));
    });

    it("fixed: reminders 4, 2 and 1 days before and on the day, moved up at its close", async () => {
      await requestDecision(conn, ctx(), body({ fixedDate: "2026-10-23", tier: "fixed" }));
      const input = raise.mock.calls[0][1];
      expect(input.dueAt).toEqual(new Date("2026-10-23T07:30:00Z"));
      expect((input.context as { schedule: { remindAt: string[] } }).schedule.remindAt).toHaveLength(4);
      expect(world.requests[0]).toMatchObject({ AutoEscalate: true });
    });

    it("soon, routine and fixed refuse to be told not to move up, before they touch the database", async () => {
      const refused: TierRequest[] = [
        { autoEscalate: false, tier: "soon" },
        { autoEscalate: false, routineWeeks: 3, tier: "routine" },
        { autoEscalate: false, fixedDate: "2026-10-23", tier: "fixed" },
      ];
      for (const tier of refused) {
        await expect(requestDecision(conn, ctx(), { ...body(), tier })).rejects.toMatchObject({
          code: "auto_escalate_not_optional",
          name: "TierError",
          status: 400,
        });
      }
      expect(world.events).toEqual([]);
      expect(db.beginTransaction).not.toHaveBeenCalled();
    });

    it("soon, routine and fixed take the tick set to true and move up as they always do", async () => {
      await requestDecision(conn, ctx(), body({ autoEscalate: true, tier: "soon" }));
      expect(raise.mock.calls[0][1].dueAt).toEqual(new Date("2026-10-19T07:30:00Z"));
      expect(world.requests[0]).toMatchObject({ AutoEscalate: true, Tier: "soon" });
    });

    it("emergency: no deadline, no reminders, nothing timed; raised urgent, to be recorded and not chased", async () => {
      const outcome = await requestDecision(conn, ctx(), body({ tier: "emergency" }));

      const input = raise.mock.calls[0][1];
      expect(input.dueAt).toBeNull();
      expect(input.urgent).toBe(true);
      expect(input.context).toMatchObject({
        decision: { callThem: true, respondBy: null, tier: "emergency" },
        schedule: { escalateAt: null, remindAt: [] },
      });
      expect(world.requests[0]).toMatchObject({ AutoEscalate: false, RespondBy: null, RoutineWeeks: null, Tier: "emergency" });
      expect(ledger.mock.calls[0][1].after).toMatchObject({ callThem: true, escalateAt: null, remindAt: [], respondBy: null });
      expect(outcome.schedule).toMatchObject({ callThem: true, timed: false });
    });

    it.each([[true], [false]])("emergency ignores the tick (%j): it is never chased, so it is stored as not moving up", async (autoEscalate) => {
      const outcome = await requestDecision(conn, ctx(), body({ autoEscalate, tier: "emergency" }));

      expect(raise.mock.calls[0][1].dueAt).toBeNull();
      expect(world.requests[0]).toMatchObject({ AutoEscalate: false, Tier: "emergency" });
      expect(outcome.request.autoEscalate).toBe(false);
    });

    it("refuses a bad date before it touches the database", async () => {
      await expect(requestDecision(conn, ctx(), body({ fixedDate: "2026-10-10", tier: "fixed" }))).rejects.toBeInstanceOf(TierError);
      await expect(requestDecision(conn, ctx(), body({ fixedDate: "2026-10-17", tier: "fixed" }))).rejects.toMatchObject({ code: "fixed_date_not_a_working_day" });
      expect(world.events).toEqual([]);
      expect(db.beginTransaction).not.toHaveBeenCalled();
    });
  });

  describe("only an Admin / Accounts job may ask", () => {
    it.each(["facilities", "maintenance"])("refuses a %s job (422) and writes nothing", async (Kind) => {
      world.job = adminJob({ Kind });

      await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "not_an_admin_job", details: { kind: Kind }, status: 422 });

      expect(writes()).toEqual([]);
      expect(world.events).toEqual(["begin", "rollback"]);
      expect(raise).not.toHaveBeenCalled();
      expect(ledger).not.toHaveBeenCalled();
    });

    it("reads a job with no kind as facilities, which is not one", async () => {
      world.job = adminJob({ Kind: null });
      await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "not_an_admin_job" });
    });

    it("refuses a job that doesn't exist (404)", async () => {
      world.job = null;
      await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "job_not_found", status: 404 });
      expect(writes()).toEqual([]);
    });

    it.each([[{ IsArchived: true }], [{ Status: "Done" }]])("refuses a closed job %j (409)", async (over) => {
      world.job = adminJob(over);
      await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "job_closed", status: 409 });
      expect(writes()).toEqual([]);
    });
  });

  it("refuses a second question while one is waiting (409), carrying the one that is, and writes nothing", async () => {
    await requestDecision(conn, ctx(), body());
    world.events.length = 0;
    raise.mockClear();
    ledger.mockClear();

    const error = await requestDecision(conn, ctx(), body({ question: "And another?" })).catch((e) => e);

    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: "already_pending", status: 409 });
    expect(error.details.request).toMatchObject({ question: "Pay the superseded lighting invoice?", requestId: 7 });
    expect(world.requests).toHaveLength(1);
    expect(world.events).toEqual(["begin", "rollback"]);
    expect(raise).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("answers an unbeatable race the same way: the unique index refuses the insert", async () => {
    world.insertError = Object.assign(new Error("Cannot insert duplicate key row ... 'UX_JobDecisionRequests_Pending'"), { number: 2601 });

    await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "already_pending", status: 409 });

    expect(world.events).toEqual(["begin", "insert request", "rollback"]);
    expect(raise).not.toHaveBeenCalled();
  });

  it("answers it the same way when the engine's own unique index refuses the escalation", async () => {
    raise.mockImplementationOnce((async () => {
      world.events.push("raise");
      throw Object.assign(new Error("Cannot insert duplicate key row ... 'UX_Escalations_Live'"), { number: 2601 });
    }) as never);

    await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "already_pending", status: 409 });

    expect(world.events).toEqual(["begin", "insert request", "raise", "rollback"]);
    expect(ledger).not.toHaveBeenCalled();
  });

  it("refuses to ask when a live escalation is already there without a request behind it", async () => {
    raise.mockImplementationOnce((async () => {
      world.events.push("raise");
      return { announce: async () => ESC, created: false, escalation: ESC };
    }) as never);

    await expect(requestDecision(conn, ctx(), body())).rejects.toMatchObject({ code: "already_pending", status: 409 });

    expect(world.events).toEqual(["begin", "insert request", "raise", "rollback"]);
    expect(ledger).not.toHaveBeenCalled();
  });

  describe("the source file", () => {
    it("is accepted when it is on the job", async () => {
      await requestDecision(conn, ctx(), body({ sourceAttachmentId: 77 }));
      expect(world.requests[0].SourceAttachmentId).toBe(77);
    });

    it("is refused (422) when it is not on this job, with nothing written", async () => {
      await expect(requestDecision(conn, ctx(), body({ sourceAttachmentId: 78 }))).rejects.toMatchObject({
        code: "attachment_not_on_job",
        details: { sourceAttachmentId: 78 },
        status: 422,
      });
      expect(writes()).toEqual([]);
      expect(world.events).toEqual(["begin", "rollback"]);
    });
  });

  describe("the people asked", () => {
    it("refuses the person asking, someone inactive and someone who can't open the inbox, writing nothing", async () => {
      for (const [userIds, code] of [
        [[3, 9], "decision_maker_is_requester"],
        [[3, 99], "decision_maker_unknown"],
        [[3, 20], "decision_maker_role_not_allowed"],
      ] as const) {
        world.events.length = 0;
        await expect(requestDecision(conn, ctx(), body({ decisionMakers: { userIds: [...userIds] } }))).rejects.toMatchObject({ code, status: 422 });
        expect(writes()).toEqual([]);
        expect(world.events).toEqual(["begin", "rollback"]);
      }
    });

    it("refuses a role with nobody else in it", async () => {
      await expect(requestDecision(conn, ctx({ actor: { ...alana, userId: 9 } }), body({ assignmentMode: "role", decisionMakers: { role: "cfo" } }))).rejects.toMatchObject({
        code: "role_has_no_one",
      });
      expect(writes()).toEqual([]);
    });
  });

  describe("no ledger row, no decision", () => {
    it("rolls the request and the escalation back, emails no one and rethrows when the decision.requested row fails", async () => {
      ledger.mockImplementationOnce(async () => {
        world.events.push("ledger:decision.requested");
        throw new Error("ledger unavailable");
      });

      await expect(requestDecision(conn, ctx(), body())).rejects.toThrow("ledger unavailable");

      expect(world.events).toEqual(["begin", "insert request", "raise", "ledger:decision.requested", "rollback"]);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(world.events).not.toContain("announce");
    });

    it("rolls everything back when the escalation (its own ledger row included) fails", async () => {
      raise.mockImplementationOnce((async () => {
        world.events.push("raise");
        throw new Error("ledger unavailable");
      }) as never);

      await expect(requestDecision(conn, ctx(), body())).rejects.toThrow("ledger unavailable");

      expect(world.events).toEqual(["begin", "insert request", "raise", "rollback"]);
      expect(ledger).not.toHaveBeenCalled();
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });

    it("rolls back when the request cannot be written", async () => {
      world.insertError = new Error("deadlock victim");

      await expect(requestDecision(conn, ctx(), body())).rejects.toThrow("deadlock victim");

      expect(world.events).toEqual(["begin", "insert request", "rollback"]);
      expect(raise).not.toHaveBeenCalled();
    });

    it("rolls back when the commit itself fails, and emails no one", async () => {
      db.commitTransaction.mockImplementationOnce(async () => {
        throw new Error("commit failed");
      });

      await expect(requestDecision(conn, ctx(), body())).rejects.toThrow("commit failed");

      expect(world.events).toContain("rollback");
      expect(world.events).not.toContain("announce");
    });

    it("survives a rollback that itself fails, and still reports the original error", async () => {
      ledger.mockRejectedValueOnce(new Error("ledger unavailable"));
      db.rollbackTransaction.mockRejectedValueOnce(new Error("connection lost"));

      await expect(requestDecision(conn, ctx(), body())).rejects.toThrow("ledger unavailable");
    });
  });

  it("never lets a failed email undo the request: the announcement is the engine's, after the commit", async () => {
    const outcome = await requestDecision(conn, ctx(), body());
    expect(world.events.indexOf("commit")).toBeLessThan(world.events.indexOf("announce"));
    expect(outcome.request.state).toBe("pending");
  });

  it("locks the job before it looks for a pending request, so two asks about one job are taken one at a time", async () => {
    await requestDecision(conn, ctx(), body());
    const sqls = db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]).replace(/\s+/g, " "));
    const lock = sqls.findIndex((s) => /FROM dbo\.Jobs j WITH \(UPDLOCK, HOLDLOCK\)/.test(s));
    const pending = sqls.findIndex((s) => /State = N'pending'/.test(s));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(pending);
  });
});

// ── withdraw ─────────────────────────────────────────────────────────────────

describe("withdrawDecision", () => {
  async function pendingRequest(): Promise<void> {
    await requestDecision(conn, ctx(), body());
    world.events.length = 0;
    raise.mockClear();
    ledger.mockClear();
    db.beginTransaction.mockClear();
    db.commitTransaction.mockClear();
    db.rollbackTransaction.mockClear();
    world.live = liveRow();
  }
  const by = (actor: UserActor, roles: string[]) => ({ actor, now: NOW, roles });
  const withdraw = (over: Record<string, unknown> = {}, who = by(alana, ["accounts"])) =>
    withdrawDecision(conn, who, { reason: "Raised on the wrong job", requestId: 7, ...over });

  it("ends the request, the escalation chasing it and ledgers decision.withdrawn, in one transaction", async () => {
    await pendingRequest();

    const withdrawn = await withdraw();

    expect(world.events).toEqual(["begin", "withdraw escalation", "mark withdrawn", "ledger:decision.withdrawn", "commit"]);
    expect(withdrawn).toMatchObject({
      requestId: 7,
      state: "withdrawn",
      withdrawnBy: "Alana",
      withdrawnByUserId: 9,
      withdrawnReason: "Raised on the wrong job",
    });
    expect(withdrawn.withdrawnAt).toEqual(NOW);
  });

  it("ends whichever escalation is live, with the reason and the ledger id the request's row shares", async () => {
    await pendingRequest();
    world.live = liveRow({ EscalationId: 101, Level: 2, TargetRole: "accounts_manager" });

    await withdraw();

    expect(withdrawEscalation).toHaveBeenCalledTimes(1);
    const input = withdrawEscalation.mock.calls[0][1];
    expect(input).toMatchObject({ actor: alana, escalationId: 101, now: NOW, reason: "Raised on the wrong job" });
    expect(ledger.mock.calls[0][1].correlationId).toBe(input.correlationId);
  });

  it("ledgers the withdrawal on the job with the reason, the request before and after", async () => {
    await pendingRequest();

    await withdraw();

    expect(ledger).toHaveBeenCalledTimes(1);
    const entry = ledger.mock.calls[0][1];
    expect(entry).toMatchObject({ action: "decision.withdrawn", actor: alana, buildingId: 5, jobId: 12, reason: "Raised on the wrong job", subject: { id: 12, type: "job" } });
    expect(entry.before).toMatchObject({ requestId: 7, state: "pending" });
    expect(entry.after).toMatchObject({ requestId: 7, state: "withdrawn", withdrawn: { by: "Alana", reason: "Raised on the wrong job" } });
  });

  it("withdraws a request that has no live escalation (its chase already ended) without trying to end one", async () => {
    await pendingRequest();
    world.live = null;

    await withdraw();

    expect(withdrawEscalation).not.toHaveBeenCalled();
    expect(world.events).toEqual(["begin", "mark withdrawn", "ledger:decision.withdrawn", "commit"]);
  });

  it("lets an admin withdraw somebody else's question, and no one else", async () => {
    await pendingRequest();
    const ada: UserActor = { kind: "user", name: "Ada", role: "admin", userId: 7 };
    const dee: UserActor = { kind: "user", name: "Dee", role: "director", userId: 5 };

    await expect(withdraw({}, by(dee, ["director"]))).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(world.requests[0].State).toBe("pending");
    expect(withdrawEscalation).not.toHaveBeenCalled();

    await expect(withdraw({}, by(ada, ["admin"]))).resolves.toMatchObject({ state: "withdrawn", withdrawnBy: "Ada" });
  });

  it("refuses a person with no Floorplan user id, who cannot be the asker", async () => {
    await pendingRequest();
    const stranger: UserActor = { kind: "user", name: "Alana", role: "accounts", userId: null };
    await expect(withdraw({}, by(stranger, ["accounts"]))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a request that doesn't exist (404)", async () => {
    await expect(withdraw({ requestId: 99 })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(world.events).toEqual(["begin", "rollback"]);
  });

  it("refuses one that is no longer waiting (409), saying how it ended and carrying it", async () => {
    await pendingRequest();
    await withdraw();
    world.events.length = 0;

    const error = await withdraw({ reason: "again" }).catch((e) => e);

    expect(error).toMatchObject({ code: "not_pending", message: "This question was already withdrawn.", status: 409 });
    expect(error.details.request).toMatchObject({ requestId: 7, state: "withdrawn" });
    expect(world.events).toEqual(["begin", "rollback"]);
    world.requests[0].State = "answered";
    await expect(withdraw()).rejects.toMatchObject({ code: "not_pending", message: "This question was already answered." });
  });

  it("refuses a stale version (409) and changes nothing", async () => {
    await pendingRequest();

    await expect(withdraw({ expectedRowVersion: Buffer.from([0, 0, 0, 0, 0, 0, 0, 9]).toString("base64") })).rejects.toMatchObject({ code: "stale", status: 409 });

    expect(world.requests[0].State).toBe("pending");
    expect(withdrawEscalation).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("accepts the version it was given", async () => {
    await pendingRequest();
    await expect(withdraw({ expectedRowVersion: rowVersion(1).toString("base64") })).resolves.toMatchObject({ state: "withdrawn" });
  });

  it("rolls the request back, and the escalation with it, when the ledger fails", async () => {
    await pendingRequest();
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(withdraw()).rejects.toThrow("ledger unavailable");

    expect(world.events).toEqual(["begin", "withdraw escalation", "mark withdrawn", "rollback"]);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls back when the engine cannot end the escalation, leaving the request pending", async () => {
    await pendingRequest();
    withdrawEscalation.mockRejectedValueOnce(new Error("deadlock victim"));

    await expect(withdraw()).rejects.toThrow("deadlock victim");

    expect(world.events).toEqual(["begin", "rollback"]);
    expect(world.requests[0].State).toBe("pending");
  });

  it("says stale when someone changes the request between the read and the write", async () => {
    await pendingRequest();
    withdrawEscalation.mockImplementationOnce((async () => {
      world.requests[0].State = "answered";
      return ESC;
    }) as never);

    await expect(withdraw()).rejects.toMatchObject({ code: "stale", status: 409 });
    expect(world.events).toContain("rollback");
  });
});
