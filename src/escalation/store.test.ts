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
  NOT_TEST_SUBJECT_SQL,
  recordNotification,
  rowVersionToBuffer,
  rowVersionToText,
  toEscalationRow,
  updateEscalation,
  type ListFilter,
  type NewEscalation,
} from "./store";
import type { Viewer } from "./types";
import { IS_TEST_SQL } from "../test-data";

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

  // What SQL Server does with `value LIKE pattern ESCAPE '\'`: % is any run of
  // characters, _ any one character, [ opens a set, and a backslash makes the
  // next character literal. Run on the pattern we actually bind.
  const regexLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function sqlLike(pattern: string, value: string): boolean {
    let source = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];
      if (ch === "\\") {
        i += 1;
        source += regexLiteral(pattern[i] ?? "");
      } else if (ch === "%") source += "[\\s\\S]*";
      else if (ch === "_") source += "[\\s\\S]";
      else if (ch === "[") throw new Error("an unescaped [ opens a character set");
      else source += regexLiteral(ch);
    }
    return new RegExp(`^${source}$`).test(value);
  }

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
    // other roles get no oversight clause (the named-people clause mentions the column too, to leave flagged rows out)
    expect(where({ view: "mine", viewer: viewer(["facilities_manager"]) }).whereSql).not.toContain("OR e.NoIndependentTarget = 1");
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
        expect(whereSql).toBe(`WHERE e.Status IN ('open', 'acknowledged') AND ${NOT_TEST_SUBJECT_SQL}`);
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

  describe("the policy filter: one exact key, or a domain by prefix", () => {
    const KEYS = [
      "finance.attribution_disputed",
      "finance.variance_disputed",
      "financex.attribution_disputed",
      "finance",
      "job.manual",
      "job.past_due",
      "rent_review.overdue",
      "rentXreview.overdue",
      "rent_review",
    ];
    // Status all and the director's all view add no clauses of their own, so
    // what is left in the WHERE is the policy filter.
    const filterBy = (over: Partial<ListFilter>) => where({ status: "all", view: "all", viewer: viewer(["director"]), ...over });
    const boundPrefix = (prefix: string): string =>
      filterBy({ policyKeyPrefix: prefix }).params.find((p) => p.name === "PolicyKeyPrefix")?.value as string;
    const matching = (prefix: string): string[] => KEYS.filter((key) => sqlLike(boundPrefix(prefix), key));

    it("an exact key is an equality on a bound value, with no LIKE", () => {
      const { params, whereSql } = filterBy({ policyKey: "finance.myob_write_failed" });

      expect(whereSql).toContain("e.PolicyKey = @PolicyKey");
      expect(whereSql).not.toContain("LIKE");
      expect(params.find((p) => p.name === "PolicyKey")).toEqual({ name: "PolicyKey", type: TYPES.NVarChar, value: "finance.myob_write_failed" });
      expect(params.some((p) => p.name === "PolicyKeyPrefix")).toBe(false);
    });

    it("a prefix is an escaped LIKE on a bound pattern", () => {
      const { params, whereSql } = filterBy({ policyKeyPrefix: "finance." });

      expect(whereSql).toBe(`WHERE ${NOT_TEST_SUBJECT_SQL} AND e.PolicyKey LIKE @PolicyKeyPrefix ESCAPE '\\'`);
      expect(params.find((p) => p.name === "PolicyKeyPrefix")).toEqual({ name: "PolicyKeyPrefix", type: TYPES.NVarChar, value: "finance.%" });
      expect(params.some((p) => p.name === "PolicyKey")).toBe(false);
    });

    it("finance. matches both finance policies, and not financex. or a bare finance", () => {
      expect(matching("finance.")).toEqual(["finance.attribution_disputed", "finance.variance_disputed"]);
    });

    it("underscores in a prefix are literal, not any-one-character", () => {
      expect(boundPrefix("rent_review.")).toBe("rent\\_review.%");
      expect(matching("rent_review.")).toEqual(["rent_review.overdue"]);
      // The test would catch a missing escape: unescaped, _ matches the X.
      expect(sqlLike("rent_review.%", "rentXreview.overdue")).toBe(true);
    });

    it("the other LIKE characters in a prefix are literal too", () => {
      expect(boundPrefix("a%b[c\\d.")).toBe("a\\%b\\[c\\\\d.%");
      expect(sqlLike(boundPrefix("a%b[c\\d."), "a%b[c\\d.rule")).toBe(true);
      expect(sqlLike(boundPrefix("a%b[c\\d."), "axyzb[c\\d.rule")).toBe(false);
    });

    it("never puts the prefix in the SQL text", () => {
      const { whereSql } = filterBy({ policyKeyPrefix: "x'; DROP--." });
      expect(whereSql).not.toContain("x'");
      expect(whereSql).not.toContain("DROP");
      expect(whereSql).not.toContain("--");
    });
  });

  describe("the CFO oversees finance. alerts, whoever they go to", () => {
    const cfo = viewer(["cfo"], 4);
    const SEEN = "e.PolicyKey LIKE @SeenPolicy0 ESCAPE '\\'";
    const seenParams = <T extends { name: string }>(params: T[]): T[] => params.filter((p) => p.name.startsWith("SeenPolicy"));

    it("team: the finance. prefix is one more way in, inside the team's own parentheses", () => {
      const { params, whereSql } = where({ view: "team", viewer: cfo });

      expect(whereSql).toMatch(
        /^WHERE \(e\.TargetRole IN \(@TeamRole0.*\) OR e\.RaisedByUserId IN \(SELECT .*\) OR e\.PolicyKey LIKE @SeenPolicy0 ESCAPE '\\'\) AND e\.Status IN \('open', 'acknowledged'\) AND \(e\.SubjectType NOT IN /,
      );
      expect(seenParams(params)).toEqual([{ name: "SeenPolicy0", type: TYPES.NVarChar, value: "finance.%" }]);
    });

    it("visible: the same clause is part of everything she may see", () => {
      const { params, whereSql } = where({ view: "visible", viewer: cfo });

      expect(whereSql).toContain(`OR ${SEEN}))`); // closes the team group, then the visible group
      expect(whereSql).toContain("e.RaisedByUserId = @ViewerUserId OR (e.TargetRole IN (");
      expect(seenParams(params)).toHaveLength(1);
    });

    it("the pattern is a constant of ours, bound; no request value reaches it", () => {
      const { params, whereSql } = where({ view: "team", viewer: cfo, subjectId: "x'; --", subjectType: "job" });

      expect(whereSql).not.toContain("finance");
      expect(seenParams(params)[0]).toMatchObject({ type: TYPES.NVarChar, value: "finance.%" });
    });

    it("the bound pattern matches finance. keys and nothing else", () => {
      const pattern = String(seenParams(where({ view: "team", viewer: cfo }).params)[0].value);
      const finance = ["finance.attribution_disputed", "finance.variance_disputed", "finance.repeated_denials", "finance.myob_write_failed"];
      const others = ["financex.attribution_disputed", "finance", "job.critical", "rent_review.approval", "any.finance.alert", "system.health"];

      expect([...finance, ...others].filter((key) => sqlLike(pattern, key))).toEqual(finance);
    });

    it("works alongside the policyKey filter", () => {
      const { params, whereSql } = where({ policyKeyPrefix: "finance.", view: "team", viewer: cfo });

      expect(whereSql).toContain(SEEN);
      expect(whereSql).toContain("e.PolicyKey LIKE @PolicyKeyPrefix ESCAPE '\\'");
      expect(names(params)).toEqual(expect.arrayContaining(["SeenPolicy0", "PolicyKeyPrefix"]));
    });

    it("mine, raised and all are untouched: her own queue stays what is aimed at her", () => {
      for (const view of ["mine", "raised", "all"] as const) {
        const { params, whereSql } = where({ view, viewer: cfo });
        expect(whereSql).not.toContain("SeenPolicy");
        expect(seenParams(params)).toEqual([]);
      }
    });

    it("nobody else gets it: other roles' team and visible views are as before", () => {
      for (const role of ["facilities_manager", "accounts_manager", "facilities", "accounts", "user", "director", "admin"]) {
        for (const view of ["team", "visible"] as const) {
          const { params, whereSql } = where({ view, viewer: viewer([role]) });
          expect(whereSql).not.toContain("SeenPolicy");
          expect(seenParams(params)).toEqual([]);
        }
      }
    });

    it("a viewer who has the CFO role among others gets it once", () => {
      expect(seenParams(where({ view: "team", viewer: viewer(["facilities", "cfo", "cfo"]) }).params)).toHaveLength(1);
    });
  });

  it("status=open is just the ones nobody has acknowledged", () => {
    expect(where({ status: "open", view: "mine", viewer: viewer(["facilities_manager"]) }).whereSql).toContain("e.Status = 'open'");
  });

  it("status=all adds no status filter (only the test-record one)", () => {
    expect(where({ status: "all", view: "all", viewer: viewer(["director"]) }).whereSql).toBe(`WHERE ${NOT_TEST_SUBJECT_SQL}`);
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

describe("test records stay out of the inbox and its counts (D9 review)", () => {
  const director: Viewer = { name: "D", roles: ["director"], userId: 5 };

  it("leaves out escalations about a test record unless an admin has Show test data on", () => {
    const hidden = buildListWhere({ status: "active", view: "all", viewer: director });
    expect(hidden.whereSql).toContain(NOT_TEST_SUBJECT_SQL);
    expect(hidden.params).toContainEqual(expect.objectContaining({ name: "ShowTest", type: TYPES.Bit, value: false }));

    const shown = buildListWhere({ showTest: true, status: "active", view: "all", viewer: director });
    expect(shown.whereSql).toContain(NOT_TEST_SUBJECT_SQL);
    expect(shown.params).toContainEqual(expect.objectContaining({ name: "ShowTest", value: true }));
  });

  it("asks positively about every kind of record a subject can be, and lets non-records through", () => {
    const [notRecords] = /e\.SubjectType NOT IN \(([^)]*)\)/.exec(NOT_TEST_SUBJECT_SQL) ?? [""];
    for (const kind of Object.keys(IS_TEST_SQL)) {
      expect(notRecords).toContain(`N'${kind}'`);
      expect(NOT_TEST_SUBJECT_SQL).toContain(`(e.SubjectType = N'${kind}' AND `);
    }
    expect(NOT_TEST_SUBJECT_SQL).not.toMatch(/NOT\s+EXISTS|IsTest = 1/);
    expect(NOT_TEST_SUBJECT_SQL).toMatch(/IsTest = 0\)+\s*OR @ShowTest = 1\)$/);
  });

  it("checks a money record and its job, and a review or change through its tenancy", () => {
    expect(NOT_TEST_SUBJECT_SQL).toContain(
      "FROM dbo.Quotes s JOIN dbo.Jobs sj ON sj.JobID = s.JobID WHERE s.QuoteID = TRY_CONVERT(INT, e.SubjectId) AND s.IsTest = 0 AND sj.IsTest = 0",
    );
    expect(NOT_TEST_SUBJECT_SQL).toContain("FROM dbo.RentReviews s JOIN dbo.Tenants st ON st.TenantId = s.TenantId WHERE s.ReviewId = e.SubjectId AND st.IsTest = 0");
  });

  it("reads a defects period's tenancy from the escalation's context, so the inbox never names a table that may not exist yet", () => {
    expect(NOT_TEST_SUBJECT_SQL).not.toContain("DefectsPeriods");
    expect(NOT_TEST_SUBJECT_SQL).toContain(
      "(e.SubjectType = N'defects_period' AND (JSON_VALUE(e.Context, N'$.tenantId') IS NULL OR EXISTS (SELECT 1 FROM dbo.Tenants st WHERE st.TenantId = TRY_CONVERT(INT, JSON_VALUE(e.Context, N'$.tenantId')) AND st.IsTest = 0)))",
    );
  });

  it("counts with the same rule as it lists (the top-bar badge)", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Total: 0 }]);
    await listEscalations(conn, { status: "active", view: "mine", viewer: director }, parsePagination(new URLSearchParams("page=1&pageSize=1")));
    expect(db.executeQuery.mock.calls[0][1]).toContain(NOT_TEST_SUBJECT_SQL);
    expect(db.executeQuery.mock.calls[1][1]).toContain(NOT_TEST_SUBJECT_SQL);
    expect(db.executeQuery.mock.calls[1][2]).toContainEqual(expect.objectContaining({ name: "ShowTest", value: false }));
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
