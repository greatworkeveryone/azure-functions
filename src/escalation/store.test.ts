/// <reference types="jest" />
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { parsePagination } from "../pagination";
import {
  buildListWhere,
  findLiveEscalation,
  getEscalationRow,
  insertEscalation,
  latestKey,
  latestTimesBySubject,
  listActiveUsers,
  listEscalations,
  recordNotification,
  rowVersionToBuffer,
  rowVersionToText,
  toEscalationRow,
  updateEscalation,
  type ListFilter,
  type NewEscalation,
} from "./store";
import type { Viewer } from "./types";

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return { ...actual, executeQuery: jest.fn() };
});
const db = require("../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;
type Call = [unknown, string, { name: string; type: unknown; value: unknown; options?: unknown }[] | undefined];
const lastCall = (): Call => db.executeQuery.mock.calls[db.executeQuery.mock.calls.length - 1] as Call;
const param = (call: Call, name: string) => call[2]?.find((p) => p.name === name);

const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 7, 208]);

function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AcknowledgedAt: null,
    AcknowledgedByName: null,
    AcknowledgedByUserId: null,
    BuildingId: 5,
    Context: '{"title":"Leaking roof"}',
    CreatedAt: new Date("2026-10-13T00:00:00Z"),
    DueAt: new Date("2026-10-14T06:00:00Z"),
    EscalationId: "42", // tedious returns BIGINT as text
    Kind: "attention",
    LastFollowUpAt: null,
    LastNotificationAttemptAt: null,
    LastNotificationError: null,
    LastNotifiedAt: null,
    Level: 1,
    NoIndependentTarget: false,
    Note: "Tenant is chasing",
    NotificationAttempts: 0,
    NotificationState: "pending",
    ParentEscalationId: null,
    PolicyKey: "job.manual",
    RaisedByKind: "user",
    RaisedByName: "Fay Staff",
    RaisedByUserId: 8,
    Reason: "stalled",
    ResolutionCode: null,
    ResolutionNote: null,
    ResolvedAt: null,
    ResolvedByName: null,
    ResolvedByUserId: null,
    RowVersion: VERSION,
    Status: "open",
    SubjectId: "12",
    SubjectType: "job",
    Summary: "Job #12",
    TargetRole: "facilities_manager",
    TargetUserId: null,
    UpdatedAt: new Date("2026-10-13T00:00:00Z"),
    Urgent: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
});

describe("toEscalationRow", () => {
  it("maps a database row, including BIGINT ids that arrive as text", () => {
    const row = toEscalationRow(rawRow());

    expect(row.escalationId).toBe(42);
    expect(row).toMatchObject({
      buildingId: 5,
      context: { title: "Leaking roof" },
      kind: "attention",
      level: 1,
      noIndependentTarget: false,
      parentEscalationId: null,
      policyKey: "job.manual",
      raisedByUserId: 8,
      status: "open",
      subjectId: "12",
      targetRole: "facilities_manager",
      targetUserId: null,
      urgent: false,
    });
  });

  it("turns the 8-byte rowversion into base64 and back", () => {
    const row = toEscalationRow(rawRow());
    expect(row.rowVersion).toBe(VERSION.toString("base64"));
    expect(rowVersionToBuffer(row.rowVersion)).toEqual(VERSION);
    expect(rowVersionToText(VERSION)).toBe(row.rowVersion);
  });

  it("refuses a rowversion that isn't 8 bytes", () => {
    expect(() => rowVersionToBuffer("AAAA")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => rowVersionToBuffer("")).toThrow(expect.objectContaining({ code: "bad_request" }));
  });

  it("copes with a missing or invalid Context", () => {
    expect(toEscalationRow(rawRow({ Context: null })).context).toBeNull();
    expect(toEscalationRow(rawRow({ Context: "not json" })).context).toBeNull();
    expect(toEscalationRow(rawRow({ Context: "[1,2]" })).context).toBeNull();
  });

  it("keeps nullable numbers null and converts present ones", () => {
    const row = toEscalationRow(rawRow({ AcknowledgedByUserId: 3, ParentEscalationId: "41", TargetUserId: 3 }));
    expect(row).toMatchObject({ acknowledgedByUserId: 3, parentEscalationId: 41, targetUserId: 3 });
  });
});

describe("reads", () => {
  it("getEscalationRow holds the row when asked, and maps null for no row", async () => {
    db.executeQuery.mockResolvedValueOnce([rawRow()]).mockResolvedValueOnce([]);

    expect((await getEscalationRow(conn, 42, { forUpdate: true }))?.escalationId).toBe(42);
    expect(lastCall()[1]).toContain("WITH (UPDLOCK, ROWLOCK)");
    expect(param(lastCall(), "EscalationId")).toMatchObject({ type: TYPES.BigInt, value: 42 });

    expect(await getEscalationRow(conn, 43)).toBeNull();
    expect(lastCall()[1]).not.toContain("UPDLOCK");
  });

  it("findLiveEscalation looks only at open and acknowledged rows for the subject and policy", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await findLiveEscalation(conn, "job", "12", "job.manual")).toBeNull();
    const [, sql] = lastCall();
    expect(sql).toContain("Status IN ('open', 'acknowledged')");
    expect(param(lastCall(), "SubjectType")?.value).toBe("job");
    expect(param(lastCall(), "SubjectId")?.value).toBe("12");
    expect(param(lastCall(), "PolicyKey")?.value).toBe("job.manual");
  });

  it("listActiveUsers lower-cases roles and tolerates a missing name or email", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { DisplayName: "Adam", Email: " adam@example.com ", Role: " Facilities_Manager ", UserID: 1 },
      { DisplayName: null, Email: null, Role: "director", UserID: 2 },
    ]);
    expect(await listActiveUsers(conn)).toEqual([
      { email: "adam@example.com", name: "Adam", role: "facilities_manager", userId: 1 },
      { email: null, name: "User 2", role: "director", userId: 2 },
    ]);
    expect(lastCall()[1]).toMatch(/IsActive = 1/);
  });

  it("latestTimesBySubject maps a row per subject and policy", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { LastCreatedAt: new Date("2026-10-10T00:00:00Z"), LastEndedAt: new Date("2026-10-11T00:00:00Z"), PolicyKey: "job.past_due", SubjectId: "12" },
      { LastCreatedAt: new Date("2026-10-09T00:00:00Z"), LastEndedAt: null, PolicyKey: "job.unassigned", SubjectId: "13" },
    ]);

    const times = await latestTimesBySubject(conn, "job");

    expect(times.get(latestKey("12", "job.past_due"))).toEqual({ lastCreatedAt: new Date("2026-10-10T00:00:00Z"), lastEndedAt: new Date("2026-10-11T00:00:00Z") });
    expect(times.get(latestKey("13", "job.unassigned"))?.lastEndedAt).toBeNull();
    expect(times.get(latestKey("13", "job.past_due"))).toBeUndefined();
  });
});

describe("writes", () => {
  const values: NewEscalation = {
    buildingId: 5,
    context: { title: "Leaking roof" },
    dueAt: new Date("2026-10-14T06:00:00Z"),
    kind: "attention",
    level: 1,
    noIndependentTarget: false,
    note: "n",
    notificationState: "pending",
    parentEscalationId: null,
    policyKey: "job.manual",
    raisedByKind: "user",
    raisedByName: "Fay",
    raisedByUserId: 8,
    reason: "stalled",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12",
    targetRole: "facilities_manager",
    targetUserId: null,
    urgent: false,
  };

  it("insertEscalation inserts as open and returns the new id as a number", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EscalationId: "99" }]);

    expect(await insertEscalation(conn, values)).toBe(99);

    const [, sql] = lastCall();
    expect(sql).toContain("INSERT INTO dbo.Escalations");
    expect(sql).toContain("'open'");
    expect(sql).toContain("OUTPUT INSERTED.EscalationId");
    expect(param(lastCall(), "Context")?.value).toBe('{"title":"Leaking roof"}');
    expect(param(lastCall(), "DueAt")).toMatchObject({ options: { scale: 3 } });
    expect(param(lastCall(), "NotificationState")?.value).toBe("pending");
    expect(param(lastCall(), "LastFollowUpAt")?.value).toBeNull();
  });

  it("insertEscalation can carry a follow-up time and a parent", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EscalationId: 100 }]);
    const at = new Date("2026-10-13T01:00:00Z");
    await insertEscalation(conn, { ...values, lastFollowUpAt: at, parentEscalationId: 99 });
    expect(param(lastCall(), "LastFollowUpAt")?.value).toBe(at);
    expect(param(lastCall(), "ParentEscalationId")).toMatchObject({ type: TYPES.BigInt, value: 99 });
  });

  it("updateEscalation changes only the allowed columns, and only at the version it holds", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EscalationId: "42" }]);

    const ok = await updateEscalation(conn, 42, VERSION.toString("base64"), { Status: "acknowledged", TargetUserId: 3, Evil: "x; DROP" } as never);

    expect(ok).toBe(true);
    const [, sql] = lastCall();
    expect(sql).toMatch(/UPDATE dbo\.Escalations SET .*Status = @Status/s);
    expect(sql).toContain("RowVersion = @RowVersion");
    expect(sql).toContain("UpdatedAt = SYSUTCDATETIME()");
    expect(sql).not.toContain("Evil");
    expect(param(lastCall(), "RowVersion")).toMatchObject({ type: TYPES.Binary, value: VERSION });
    expect(param(lastCall(), "TargetUserId")?.value).toBe(3);
  });

  it("updateEscalation reports a stale version as false", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await updateEscalation(conn, 42, VERSION.toString("base64"), { Status: "resolved" })).toBe(false);
  });

  it("updateEscalation refuses an empty change", async () => {
    await expect(updateEscalation(conn, 42, VERSION.toString("base64"), {})).rejects.toThrow();
  });

  it("recordNotification writes bookkeeping without checking the version, and clips the error", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const now = new Date("2026-10-13T01:00:00Z");

    await recordNotification(conn, 42, { attemptedAt: now, error: "x".repeat(900), notifiedAt: null, state: "failed" }, 3);

    const [, sql] = lastCall();
    expect(sql).toContain("NotificationAttempts = NotificationAttempts + @Increment");
    expect(sql).toContain("LastNotifiedAt = COALESCE(@NotifiedAt, LastNotifiedAt)");
    expect(sql).not.toContain("RowVersion");
    expect(param(lastCall(), "Increment")?.value).toBe(3);
    expect((param(lastCall(), "Error")?.value as string).length).toBe(500);
    expect(param(lastCall(), "State")?.value).toBe("failed");
  });
});

describe("buildListWhere: who sees what in the inbox (PLAN §3.7)", () => {
  const viewer = (roles: string[], userId: number | null = 3): Viewer => ({ name: "V", roles, userId });
  const where = (over: Partial<ListFilter> & Pick<ListFilter, "view" | "viewer">) =>
    buildListWhere({ status: "active", ...over });
  const names = (params: { name: string }[]) => params.map((p) => p.name);

  it("mine: named for me, or aimed at my role and not named for anyone else", () => {
    const { params, whereSql } = where({ view: "mine", viewer: viewer(["facilities_manager"]) });

    expect(whereSql).toContain("e.TargetUserId = @ViewerUserId OR (e.TargetUserId IS NULL AND e.TargetRole IN (@MineRole0))");
    expect(whereSql).toContain("e.Status IN ('open', 'acknowledged')");
    expect(params.find((p) => p.name === "MineRole0")?.value).toBe("facilities_manager");
    expect(params.find((p) => p.name === "ViewerUserId")?.value).toBe(3);
  });

  it("mine: an escalation nobody independent could take is for every director and admin", () => {
    for (const role of ["director", "admin"]) {
      expect(where({ view: "mine", viewer: viewer([role]) }).whereSql).toContain("OR e.NoIndependentTarget = 1");
    }
    expect(where({ view: "mine", viewer: viewer(["facilities_manager"]) }).whereSql).not.toContain("NoIndependentTarget");
  });

  it("raised: the ones I raised", () => {
    expect(where({ view: "raised", viewer: viewer(["facilities"]) }).whereSql).toContain("e.RaisedByUserId = @ViewerUserId");
  });

  it("team: a manager's own roles and what their staff raised", () => {
    const { params, whereSql } = where({ view: "team", viewer: viewer(["facilities_manager"]) });

    expect(whereSql).toContain("e.TargetRole IN (@TeamRole0, @TeamRole1)");
    expect(whereSql).toContain("SELECT u.UserID FROM dbo.AppUsers u WHERE u.Role IN (@TeamRole0, @TeamRole1)");
    expect(params.filter((p) => p.name.startsWith("TeamRole")).map((p) => p.value)).toEqual(["facilities_manager", "facilities"]);
  });

  it("team: the CFO covers both sides", () => {
    const { params } = where({ view: "team", viewer: viewer(["cfo"]) });
    expect(params.filter((p) => p.name.startsWith("TeamRole")).map((p) => p.value)).toEqual(
      expect.arrayContaining(["cfo", "accounts_manager", "facilities_manager", "accounts", "facilities"]),
    );
  });

  it("team: someone with no team sees nothing", () => {
    expect(where({ view: "team", viewer: viewer(["facilities"]) }).whereSql).toContain("1 = 0");
  });

  it("directors and admin are not narrowed by team, all or visible", () => {
    for (const role of ["director", "admin"]) {
      for (const view of ["team", "all", "visible"] as const) {
        const { whereSql } = where({ view, viewer: viewer([role]) });
        expect(whereSql).toBe("WHERE e.Status IN ('open', 'acknowledged')");
      }
    }
  });

  it("visible: mine, role-mates', raised and team, for everyone else", () => {
    const { whereSql } = where({ view: "visible", viewer: viewer(["facilities_manager"]) });
    expect(whereSql).toContain("e.TargetRole IN (@OwnRole0)");
    expect(whereSql).toContain("e.RaisedByUserId = @ViewerUserId");
    expect(whereSql).toContain("@TeamRole0");
    expect(whereSql).toMatch(/ OR /);
  });

  it("filters by status, subject, policy, kind and urgency", () => {
    const { params, whereSql } = where({
      kind: "attention",
      policyKey: "job.manual",
      status: "closed",
      subjectId: "12",
      subjectType: "job",
      urgent: true,
      view: "all",
      viewer: viewer(["director"]),
    });

    expect(whereSql).toContain("e.Status IN ('resolved', 'superseded', 'withdrawn')");
    expect(whereSql).toContain("e.SubjectType = @SubjectType AND e.SubjectId = @SubjectId");
    expect(whereSql).toContain("e.PolicyKey = @PolicyKey");
    expect(whereSql).toContain("e.Kind = @Kind");
    expect(whereSql).toContain("e.Urgent = @Urgent");
    expect(names(params)).toEqual(expect.arrayContaining(["SubjectType", "SubjectId", "PolicyKey", "Kind", "Urgent"]));
  });

  it("status=open is just the ones nobody has acknowledged", () => {
    expect(where({ status: "open", view: "mine", viewer: viewer(["facilities_manager"]) }).whereSql).toContain("e.Status = 'open'");
  });

  it("status=all adds no status filter", () => {
    expect(where({ status: "all", view: "all", viewer: viewer(["director"]) }).whereSql).toBe("");
  });

  it("never puts a value in the SQL text", () => {
    const { whereSql } = where({ policyKey: "x'; --", subjectId: "1 OR 1=1", subjectType: "job", view: "mine", viewer: viewer(["facilities_manager']; --"]) });
    expect(whereSql).not.toContain("--");
    expect(whereSql).not.toContain("1=1");
  });

  it("a viewer with no roles matches nothing by role", () => {
    const { params } = where({ view: "mine", viewer: viewer([]) });
    expect(params.find((p) => p.name === "MineRole0")?.value).toBe("");
  });
});

describe("listChain", () => {
  it("returns the newest 200 rows for the subject and policy, oldest first", async () => {
    const { listChain } = jest.requireActual("./store") as typeof import("./store");
    db.executeQuery.mockResolvedValueOnce([rawRow({ EscalationId: "43" }), rawRow({ EscalationId: "42" })]);

    const chain = await listChain(conn, toEscalationRow(rawRow()));

    expect(chain.map((c) => c.escalationId)).toEqual([42, 43]);
    expect(lastCall()[1]).toContain("SELECT TOP 200");
    expect(lastCall()[1]).toContain("ORDER BY EscalationId DESC");
  });
});

describe("listEscalations", () => {
  it("pages with OFFSET/FETCH and counts the whole view", async () => {
    db.executeQuery.mockResolvedValueOnce([rawRow()]).mockResolvedValueOnce([{ Total: 31 }]);
    const filter: ListFilter = { status: "active", view: "all", viewer: { name: "D", roles: ["director"], userId: 5 } };

    const result = await listEscalations(conn, filter, parsePagination(new URLSearchParams("page=2&pageSize=10")));

    expect(result.total).toBe(31);
    expect(result.rows).toHaveLength(1);
    const listSql = db.executeQuery.mock.calls[0][1] as string;
    expect(listSql).toContain("OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY");
    expect(listSql).not.toContain("TOP ");
    expect(listSql).toContain("ORDER BY e.Urgent DESC");
    expect(db.executeQuery.mock.calls[1][1]).toContain("COUNT(*)");
  });

  it("caps an unpaged list at the safety ceiling and orders closed ones newest first", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Total: 0 }]);
    const filter: ListFilter = { status: "closed", view: "all", viewer: { name: "D", roles: ["director"], userId: 5 } };

    await listEscalations(conn, filter, parsePagination(new URLSearchParams()));

    const listSql = db.executeQuery.mock.calls[0][1] as string;
    expect(listSql).toContain("TOP 5000");
    expect(listSql).toContain("ORDER BY e.UpdatedAt DESC");
    expect(listSql).not.toContain("SELECT *");
  });
});
