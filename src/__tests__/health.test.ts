/// <reference types="jest" />
// DL-12: /api/health?deep=true names what is wrong instead of features quietly
// switching themselves off — missing settings, pending migrations, and the
// last run of every timer.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../migrate", () => ({ checkMigrations: jest.fn() }));

import { ENV_CONTRACT } from "../config/envContract";
import { health } from "../functions/health";

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const { checkMigrations } = jest.requireMock("../migrate") as { checkMigrations: jest.Mock };
const auth = jest.requireMock("../auth") as { requireRole: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const deep = { headers: new Headers(), query: new URLSearchParams("deep=true") } as unknown as HttpRequest;
const SAVED = { ...process.env };

function setAllSettings() {
  for (const entry of ENV_CONTRACT) process.env[entry.name] = "x";
  process.env.API_TOKEN_AUDIENCE = "sql";
  process.env.APP_CLIENT_ID = "client";
  delete process.env.SQL_USER_CONNECTION;
}

beforeEach(() => {
  jest.clearAllMocks();
  setAllSettings();
  for (const name of ["DEV_EMAIL_OVERRIDE", "EMAIL_REPLY_DECISIONS_ENABLED", "TEAMS_ALERTS_ENABLED", "TEAMS_ALERTS_DRY_RUN"]) delete process.env[name];
  checkMigrations.mockResolvedValue({ changed: [], invalid: [], missing: [], outOfOrder: [], pending: [], unverified: [] });
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM STRING_SPLIT/.test(sql)) {
      return [
        { Error: null, FinishedAt: new Date("2026-10-14T03:00:05Z"), Name: "ledgerVerifyTimer", Outcome: "ok", StartedAt: new Date("2026-10-14T03:00:00Z") },
        { Error: null, FinishedAt: null, Name: "plannerSyncTimer", Outcome: null, StartedAt: null },
      ];
    }
    return [{ Ok: 1 }];
  });
});

afterAll(() => {
  process.env = SAVED;
});

describe("health?deep=true", () => {
  it("reports the active API token audience mode", async () => {
    process.env.API_TOKEN_AUDIENCE = "both";
    const body = (await health(deep, ctx)).jsonBody as { apiTokenAudience: string; ok: boolean };
    expect(body.apiTokenAudience).toBe("both");
    expect(body.ok).toBe(true);
  });

  it("is not ok when the audience mode is invalid", async () => {
    process.env.API_TOKEN_AUDIENCE = "bogus";
    const body = (await health(deep, ctx)).jsonBody as { apiTokenAudience: string; ok: boolean };
    expect(body.apiTokenAudience).toBe("sql");
    expect(body.ok).toBe(false);
  });

  it("reports a missing required setting by name, with what it breaks, and is not ok", async () => {
    delete process.env.SENTRY_DSN;
    const res = await health(deep, ctx);
    const body = res.jsonBody as { ok: boolean; settings: { missing: { effect: string; name: string; requiredInProd: boolean }[] } };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.settings.missing).toEqual([
      expect.objectContaining({ name: "SENTRY_DSN", requiredInProd: true, effect: expect.stringMatching(/Sentry/) }),
    ]);
  });

  it("lists an optional setting that is missing without failing the check", async () => {
    delete process.env.TODDLER_URL;
    const body = (await health(deep, ctx)).jsonBody as { ok: boolean; settings: { missing: { name: string; requiredInProd: boolean }[] } };
    expect(body.settings.missing).toEqual([expect.objectContaining({ name: "TODDLER_URL", requiredInProd: false })]);
    expect(body.ok).toBe(true);
  });

  it("treats an empty value as missing", async () => {
    process.env.SQL_DATABASE = "  ";
    const body = (await health(deep, ctx)).jsonBody as { settings: { missing: { name: string }[] } };
    expect(body.settings.missing.map((m) => m.name)).toEqual(["SQL_DATABASE"]);
  });

  it("lists a dev lever that is set in Production and fails the check", async () => {
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Production";
    process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";
    const body = (await health(deep, ctx)).jsonBody as { ok: boolean; settings: { forbidden: { name: string }[] } };
    expect(body.settings.forbidden.map((f) => f.name)).toEqual(["DEV_EMAIL_OVERRIDE"]);
    expect(body.ok).toBe(false);
  });

  it("reports a warn-level forbidden setting without failing the check", async () => {
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Production";
    process.env.EMAIL_REPLY_DECISIONS_ENABLED = "true";
    const body = (await health(deep, ctx)).jsonBody as { ok: boolean; settings: { forbidden: { name: string }[] } };
    expect(body.settings.forbidden.map((f) => f.name)).toEqual(["EMAIL_REPLY_DECISIONS_ENABLED"]);
    expect(body.ok).toBe(true);
  });

  it("is not ok when Teams alerts are on but the flow isn't configured", async () => {
    process.env.TEAMS_ALERTS_ENABLED = "true";
    delete process.env.TEAMS_WORKFLOW_WEBHOOK_URL;
    const body = (await health(deep, ctx)).jsonBody as { alerts: { problem: string | null }; ok: boolean };
    expect(body.alerts.problem).toBe("TEAMS_WORKFLOW_WEBHOOK_URL or TEAMS_WORKFLOW_KEY is unset");
    expect(body.ok).toBe(false);
  });

  it("lists pending and changed migrations", async () => {
    checkMigrations.mockResolvedValue({
      changed: [{ current: "b", name: "120_a.sql", recorded: "a" }],
      invalid: [],
      missing: [],
      outOfOrder: [],
      pending: [{ name: "128_timer_runs.sql" }],
      unverified: ["001_init.sql"],
    });
    const body = (await health(deep, ctx)).jsonBody as { migrations: unknown; ok: boolean };
    expect(body.migrations).toEqual({ changed: ["120_a.sql"], pending: ["128_timer_runs.sql"], unverified: 1 });
    expect(body.ok).toBe(false);
  });

  it("shows the last run of every timer, including ones that never ran", async () => {
    const body = (await health(deep, ctx)).jsonBody as { timers: { lastRun: unknown; name: string }[] };
    expect(body.timers).toContainEqual({
      lastRun: { error: null, finishedAt: "2026-10-14T03:00:05.000Z", outcome: "ok", startedAt: "2026-10-14T03:00:00.000Z" },
      name: "ledgerVerifyTimer",
    });
    expect(body.timers).toContainEqual({ lastRun: null, name: "plannerSyncTimer" });
  });

  it("is not ok when a timer's last run failed", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /FROM STRING_SPLIT/.test(sql)
        ? [{ Error: "Login failed", FinishedAt: new Date(), Name: "syncAllWorkRequestsTimer", Outcome: "error", StartedAt: new Date() }]
        : [{ Ok: 1 }],
    );
    expect(((await health(deep, ctx)).jsonBody as { ok: boolean }).ok).toBe(false);
  });

  it("still answers when TimerRuns doesn't exist yet (migration 128 pending)", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM STRING_SPLIT/.test(sql)) throw new Error("Invalid object name 'dbo.TimerRuns'.");
      return [{ Ok: 1 }];
    });
    const res = await health(deep, ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { timers: unknown }).timers).toBe("unavailable");
  });

  it("stays admin-only and minimal without deep", async () => {
    auth.requireRole.mockResolvedValueOnce({ status: 403, jsonBody: { error: "Forbidden" } });
    expect((await health(deep, ctx)).status).toBe(403);
    const shallow = await health({ headers: new Headers(), query: new URLSearchParams() } as unknown as HttpRequest, ctx);
    expect(shallow.jsonBody).toEqual({ ok: true });
  });
});
