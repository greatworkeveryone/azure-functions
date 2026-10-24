/// <reference types="jest" />
import { parsePeriod } from "../period";
import { FINANCE_ACTION_LIKE, FINANCE_MODULE_KEYS, FINANCE_USER_ROLES } from "../scope";
import { loadUsageAi } from "./ai";
import { loadUsageDevices } from "./devices";
import { loadUsageEmail } from "./email";
import { loadUsageFinance } from "./finance";
import { loadUsageModules } from "./modules";
import { loadUsageOverview } from "./overview";
import { loadUsagePeople } from "./people";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
import { executeQuery } from "../../db";

const query = jest.mocked(executeQuery);
const conn = {} as never;
const parsed = parsePeriod(new URLSearchParams("from=2026-10-19&to=2026-10-24"), new Date("2026-10-24T03:00:00Z"));
if (!("period" in parsed)) throw new Error("period");
const period = parsed.period;

/** Answers each query in order from a list of row sets. */
function rows(...sets: Record<string, unknown>[][]) {
  const queue = [...sets];
  query.mockImplementation(async () => queue.shift() ?? []);
}
const sqlOf = (index: number) => String(query.mock.calls[index][1]);
const paramsOf = (index: number) => (query.mock.calls[index][2] ?? []) as { name: string; value: unknown }[];

beforeEach(() => jest.clearAllMocks());

describe("overview", () => {
  it("adds the daily roll-up into totals, rounds the median and keeps the heatmap cells", async () => {
    rows(
      [
        { ActivePeople: 4, ActiveSeconds: 3600, Day: "2026-10-22", Sessions: 6 },
        { ActivePeople: 5, ActiveSeconds: 5400, Day: "2026-10-23", Sessions: 9 },
      ],
      [{ N: 7 }],
      [{ Median: 612.5 }],
      [{ Hour: 9, Seconds: 1800, Weekday: 0 }, { Hour: 14, Seconds: 600, Weekday: 4 }],
    );
    expect(await loadUsageOverview(conn, period)).toEqual({
      activePeople: 7,
      activeSeconds: 9000,
      daily: [
        { activePeople: 4, activeSeconds: 3600, day: "2026-10-22", sessions: 6 },
        { activePeople: 5, activeSeconds: 5400, day: "2026-10-23", sessions: 9 },
      ],
      heatmap: [{ hour: 9, seconds: 1800, weekday: 0 }, { hour: 14, seconds: 600, weekday: 4 }],
      medianSessionSeconds: 613,
      period: { days: 6, from: "2026-10-19", to: "2026-10-24" },
      sessions: 15,
    });
  });

  it("says nothing was recorded with zeros and a null median, not an error", async () => {
    rows([], [{ N: 0 }], [], []);
    expect(await loadUsageOverview(conn, period)).toMatchObject({ activePeople: 0, activeSeconds: 0, daily: [], heatmap: [], medianSessionSeconds: null, sessions: 0 });
  });

  it("reads the heatmap in Darwin time with Monday as day 0", async () => {
    rows([], [], [], []);
    await loadUsageOverview(conn, period);
    expect(sqlOf(3)).toMatch(/DATEADD\(MINUTE, 570, EnteredAt\)/);
    expect(sqlOf(3)).toMatch(/DATEDIFF\(DAY, '19000101'/);
    expect(paramsOf(3).map((p) => p.name)).toEqual(["FromUtc", "ToUtc"]);
  });
});

describe("people", () => {
  const totals = [
    { ActiveSeconds: 5000, DisplayName: "Ann", LastDay: "2026-10-23", Role: "accounts", Sessions: 5, UserId: 1 },
    { ActiveSeconds: 900, DisplayName: "Bo", LastDay: "2026-10-20", Role: "facilities", Sessions: 2, UserId: 2 },
  ];

  it("groups each person's devices, top three modules and calendar", async () => {
    rows(
      totals,
      [{ DeviceClass: "desktop", Seconds: 4000, UserId: 1 }, { DeviceClass: "phone", Seconds: 1000, UserId: 1 }, { DeviceClass: "tablet", Seconds: 900, UserId: 2 }],
      [
        { ModuleKey: "finance", Seconds: 3000, UserId: 1 },
        { ModuleKey: "jobs", Seconds: 500, UserId: 1 },
        { ModuleKey: "tenancy", Seconds: 900, UserId: 1 },
        { ModuleKey: "keys", Seconds: 100, UserId: 1 },
        { ModuleKey: "inspections", Seconds: 900, UserId: 2 },
      ],
      [{ Day: "2026-10-22", Seconds: 2500, UserId: 1 }, { Day: "2026-10-23", Seconds: 2500, UserId: 1 }, { Day: "2026-10-20", Seconds: 900, UserId: 2 }],
    );
    const people = await loadUsagePeople(conn, period, { moduleKeys: null, roles: null, userId: null });
    expect(people.map((p) => p.name)).toEqual(["Ann", "Bo"]);
    expect(people[0].topModules).toEqual([{ moduleKey: "finance", seconds: 3000 }, { moduleKey: "tenancy", seconds: 900 }, { moduleKey: "jobs", seconds: 500 }]);
    expect(people[0].devices).toHaveLength(2);
    expect(people[0].calendar).toEqual([{ day: "2026-10-22", seconds: 2500 }, { day: "2026-10-23", seconds: 2500 }]);
    expect(people[1]).toMatchObject({ lastActiveDay: "2026-10-20", sessions: 2, topModules: [{ moduleKey: "inspections", seconds: 900 }] });
  });

  it("lists only the allowed modules when asked, so a scoped view never names another module", async () => {
    rows(totals.slice(0, 1), [], [{ ModuleKey: "inspections", Seconds: 9000, UserId: 1 }, { ModuleKey: "finance", Seconds: 10, UserId: 1 }], []);
    const [ann] = await loadUsagePeople(conn, period, { moduleKeys: ["finance"], roles: null, userId: null });
    expect(ann.topModules).toEqual([{ moduleKey: "finance", seconds: 10 }]);
  });

  it("binds roles and the person as parameters, never into the text", async () => {
    rows([], [], [], []);
    await loadUsagePeople(conn, period, { moduleKeys: null, roles: ["accounts", "cfo"], userId: 5 });
    for (let i = 0; i < 4; i += 1) {
      expect(sqlOf(i)).toMatch(/LOWER\(u\.Role\) IN \(SELECT value FROM OPENJSON\(@Roles\)\)/);
      expect(sqlOf(i)).toMatch(/@UserId IS NULL OR d\.UserId = @UserId/);
      expect(sqlOf(i)).not.toMatch(/accounts|cfo/);
      expect(paramsOf(i).find((p) => p.name === "Roles")?.value).toBe('["accounts","cfo"]');
      expect(paramsOf(i).find((p) => p.name === "UserId")?.value).toBe(5);
    }
  });

  it("adds up only the allowed modules when they are given, in every query, never the all-modules totals", async () => {
    rows([], [], [], []);
    await loadUsagePeople(conn, period, { moduleKeys: ["finance", "admin/myob"], roles: null, userId: null });
    for (let i = 0; i < 4; i += 1) {
      expect(paramsOf(i).find((p) => p.name === "Keys")?.value).toBe('["finance","admin/myob"]');
      expect(sqlOf(i)).toMatch(/d\.ModuleKey IN \(SELECT value FROM OPENJSON\(@Keys\)\)/);
    }
  });

  it("sends no module list, so the all-modules totals are used, when there is no restriction", async () => {
    rows([], [], [], []);
    await loadUsagePeople(conn, period, { moduleKeys: null, roles: null, userId: null });
    expect(paramsOf(0).find((p) => p.name === "Keys")?.value).toBeNull();
  });

  it("applies no narrowing for null, as null parameters", async () => {
    rows([], [], [], []);
    await loadUsagePeople(conn, period, { moduleKeys: null, roles: null, userId: null });
    expect(paramsOf(0).find((p) => p.name === "Roles")?.value).toBeNull();
    expect(paramsOf(0).find((p) => p.name === "UserId")?.value).toBeNull();
  });

  it("matches nobody for an empty role list rather than everybody", async () => {
    rows([], [], [], []);
    await loadUsagePeople(conn, period, { moduleKeys: null, roles: [], userId: null });
    expect(paramsOf(0).find((p) => p.name === "Roles")?.value).toBe("[]");
  });
});

describe("devices", () => {
  it("answers which class each role uses per module, names shared tablets and lists likely shared ones", async () => {
    const device = { BrowserFamily: "Chrome", DeviceClass: "tablet", DeviceId: "d_tablet", LastSeenAt: new Date("2026-10-23T01:00:00Z"), OsFamily: "Android", People: 3, Seconds: 7200 };
    rows(
      [{ DeviceClass: "phone", People: 8, Seconds: 1000 }, { DeviceClass: "tablet", People: 3, Seconds: 7200 }],
      [{ DeviceClass: "tablet", ModuleKey: "inspections", People: 3, Role: "facilities", Seconds: 6000 }, { DeviceClass: "phone", ModuleKey: "inspections", People: 2, Role: "facilities", Seconds: 600 }],
      [{ ...device, Label: "Facilities tablet" }],
      [{ ...device, DeviceId: "d_other", Label: null }],
      [{ DeviceId: "d_tablet", ModuleKey: "inspections", Seconds: 6000 }, { DeviceId: "d_tablet", ModuleKey: "keys", Seconds: 1200 }],
    );
    const result = await loadUsageDevices(conn, period);
    expect(result.classShare).toEqual([{ deviceClass: "phone", people: 8, seconds: 1000 }, { deviceClass: "tablet", people: 3, seconds: 7200 }]);
    expect(result.roleModule.filter((r) => r.moduleKey === "inspections" && r.role === "facilities").map((r) => [r.deviceClass, r.seconds])).toEqual([["tablet", 6000], ["phone", 600]]);
    expect(result.named).toHaveLength(1);
    expect(result.named[0]).toMatchObject({ label: "Facilities tablet", lastSeenAt: "2026-10-23T01:00:00.000Z", people: 3 });
    expect(result.named[0].modules).toEqual([{ moduleKey: "inspections", seconds: 6000 }, { moduleKey: "keys", seconds: 1200 }]);
    expect(result.sharedUnnamed.map((d) => d.deviceId)).toEqual(["d_other"]);
  });

  it("only asks for named devices' modules when there are named devices", async () => {
    rows([], [], [], []);
    await loadUsageDevices(conn, period);
    expect(query).toHaveBeenCalledTimes(4);
  });
});

describe("modules", () => {
  it("maps modules and modules by role", async () => {
    rows([{ ModuleKey: "jobs", People: 9, Seconds: 9000, Views: 120 }], [{ ModuleKey: "jobs", People: 4, Role: "facilities", Seconds: 6000 }]);
    expect(await loadUsageModules(conn, period)).toMatchObject({
      byRole: [{ moduleKey: "jobs", people: 4, role: "facilities", seconds: 6000 }],
      modules: [{ moduleKey: "jobs", people: 9, seconds: 9000, views: 120 }],
    });
  });
});

describe("email", () => {
  it("totals the weeks and counts only queued sends", async () => {
    rows(
      [{ Blocked: 0, Failed: 1, Recipients: 40, Sends: 3, Sent: 39, WeekStart: "2026-10-12" }, { Blocked: 2, Failed: 0, Recipients: 10, Sends: 1, Sent: 8, WeekStart: "2026-10-19" }],
      [{ Kind: "broadcast", Recipients: 45, Sends: 3 }, { Kind: "letter", Recipients: 5, Sends: 1 }],
      [{ Recipients: 45, Sends: 3, TemplateId: "rent-notice" }, { Recipients: 5, Sends: 1, TemplateId: null }],
      [{ IdentityName: "Accounts", Recipients: 30, Sends: 2, TeamLabel: "Accounts team" }],
      [{ N: 47, Status: "sent" }, { N: 1, Status: "failed" }, { N: 2, Status: "blocked" }],
      [{ N: 40, RecipientType: "tenancy" }, { N: 10, RecipientType: "contractor" }],
    );
    const email = await loadUsageEmail(conn, period);
    expect(email.totals).toEqual({ recipients: 50, sends: 4 });
    expect(email.weekly[1]).toEqual({ blocked: 2, failed: 0, recipients: 10, sends: 1, sent: 8, weekStart: "2026-10-19" });
    expect(email.byTemplate[1].templateId).toBeNull();
    expect(email.byIdentity[0]).toEqual({ identity: "Accounts", recipients: 30, sends: 2, team: "Accounts team" });
    expect(email.outcomes).toEqual([{ count: 47, status: "sent" }, { count: 1, status: "failed" }, { count: 2, status: "blocked" }]);
    for (let i = 0; i < 6; i += 1) expect(sqlOf(i)).toMatch(/c\.QueuedAt IS NOT NULL/);
  });

  it("reads no subject, body or address", async () => {
    rows([], [], [], [], [], []);
    await loadUsageEmail(conn, period);
    for (let i = 0; i < 6; i += 1) expect(sqlOf(i)).not.toMatch(/Subject|BodyMarkdown|r\.Address|SentToAddress|MergeValues/);
  });
});

describe("ai", () => {
  it("adds purposes into totals and rounds the latency", async () => {
    rows(
      [{ AvgLatency: 120.4, Failed: 1, Ok: 8, Purpose: "library_answer", Refused: 1, Total: 10 }, { AvgLatency: null, Failed: 0, Ok: 0, Purpose: "echo_test", Refused: 2, Total: 2 }],
      [{ Calls: 7, Day: "2026-10-22" }, { Calls: 5, Day: "2026-10-23" }],
    );
    const ai = await loadUsageAi(conn, period);
    expect(ai.totals).toEqual({ calls: 12, failed: 1, ok: 8, refused: 3 });
    expect(ai.byPurpose[0].avgLatencyMs).toBe(120);
    expect(ai.byPurpose[1].avgLatencyMs).toBeNull();
    expect(sqlOf(0)).not.toMatch(/InputText|OutputText|ActorName|ActorEmail|RecordId/);
  });
});

describe("finance", () => {
  const empty = () => rows([], [], [], [], [], [], [], [], [], []);
  const jsonParam = (index: number, name: string) => JSON.parse(String(paramsOf(index).find((p) => p.name === name)?.value));

  it("limits people to the finance roles and time to the finance modules, with every value bound", async () => {
    empty();
    await loadUsageFinance(conn, period, { role: null, scope: "finance", userId: null });
    const moduleSql = query.mock.calls.map((_c, i) => i).find((i) => /GROUP BY d\.ModuleKey/.test(sqlOf(i))) as number;
    expect(jsonParam(moduleSql, "Keys")).toEqual([...FINANCE_MODULE_KEYS]);
    for (let i = 0; i < 4; i += 1) expect(jsonParam(i, "Keys")).toEqual([...FINANCE_MODULE_KEYS]);
    expect(jsonParam(moduleSql, "Roles")).toEqual([...FINANCE_USER_ROLES]);
    for (let i = 0; i < query.mock.calls.length; i += 1) expect(sqlOf(i)).not.toMatch(/facilities|inspections|'finance'|accounts_manager/);
  });

  it("narrows to one role when a role is sent", async () => {
    empty();
    await loadUsageFinance(conn, period, { role: "accounts", scope: "finance", userId: null });
    expect(jsonParam(0, "Roles")).toEqual(["accounts"]);
  });

  it("selects money decisions positively, by code prefix, and never reads reasons or amounts", async () => {
    empty();
    await loadUsageFinance(conn, period, { role: null, scope: "finance", userId: null });
    const decisions = query.mock.calls.map((_c, i) => i).filter((i) => /DecisionLedger/.test(sqlOf(i)));
    expect(decisions).toHaveLength(2);
    for (const i of decisions) {
      expect(jsonParam(i, "Likes")).toEqual([...FINANCE_ACTION_LIKE]);
      expect(sqlOf(i)).toMatch(/EXISTS \(SELECT 1 FROM OPENJSON\(@Likes\) WHERE l\.Action LIKE value\)/);
      expect(sqlOf(i)).not.toMatch(/Reason|FinancialImpact|\[Before\]|\[After\]|SubjectId/);
    }
  });

  it("reads MYOB calls by operation, outcome and person, but never a path or a body", async () => {
    empty();
    await loadUsageFinance(conn, period, { role: null, scope: "finance", userId: null });
    const myob = query.mock.calls.map((_c, i) => i).filter((i) => /MyobApiLog/.test(sqlOf(i)));
    expect(myob).toHaveLength(2);
    for (const i of myob) {
      expect(sqlOf(i)).toMatch(/Phase IN \(N'response', N'error'\)/);
      expect(sqlOf(i)).not.toMatch(/Path|RequestBody|ResponseBody|MyobUid|ErrorMessage/);
    }
  });

  it("narrows to one person across people, decisions and MYOB calls when a userId is sent", async () => {
    empty();
    await loadUsageFinance(conn, period, { role: null, scope: "finance", userId: 12 });
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(query.mock.calls.every((_c, i) => paramsOf(i).some((p) => p.name === "UserId" && p.value === 12))).toBe(true);
  });

  it("maps the figures", async () => {
    rows(
      [{ ActiveSeconds: 600, DisplayName: "Ann", LastDay: "2026-10-23", Role: "accounts", Sessions: 2, UserId: 1 }],
      [],
      [{ ModuleKey: "finance", Seconds: 400, UserId: 1 }],
      [],
      [{ ModuleKey: "finance", People: 1, Seconds: 400 }],
      [{ Action: "invoice.approve", N: 5 }],
      [{ ActorName: "Ann", N: 5, Role: "accounts" }],
      [{ Failed: 1, Ok: 9, Purpose: "purchase.create" }],
      [{ ActorName: "Ann", Failed: 1, Ok: 9 }],
    );
    const result = await loadUsageFinance(conn, period, { role: null, scope: "finance", userId: null });
    expect(result.scope).toBe("finance");
    expect(result.people[0]).toMatchObject({ name: "Ann", topModules: [{ moduleKey: "finance", seconds: 400 }] });
    expect(result.modules).toEqual([{ moduleKey: "finance", people: 1, seconds: 400 }]);
    expect(result.decisions.byAction).toEqual([{ action: "invoice.approve", count: 5 }]);
    expect(result.myob.byOperation).toEqual([{ failed: 1, ok: 9, operation: "purchase.create" }]);
    expect(result.myob.byPerson).toEqual([{ failed: 1, ok: 9, person: "Ann" }]);
  });
});
