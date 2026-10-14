// Shared test plumbing for the facilities handlers (sprint F): a route-based
// executeQuery fake, request builders and row fixtures. Each test file still
// declares its own jest.mock calls (they are hoisted per file).

import type { HttpRequest } from "@azure/functions";

export type Row = Record<string, unknown>;
export type Route = { match: RegExp; rows?: Row[] | ((params: Row, sql: string) => Row[]); throws?: Error };
export type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

/** Answers each query with the first route whose pattern matches; [] otherwise. */
export function routeQueries(executeQuery: jest.Mock, routes: Route[]): void {
  executeQuery.mockImplementation(async (_connection: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (!hit) return [];
    if (hit.throws) throw hit.throws;
    const byName = Object.fromEntries(params.map((p) => [p.name, p.value]));
    return typeof hit.rows === "function" ? hit.rows(byName, sql) : (hit.rows ?? []);
  });
}

export const callsMatching = (executeQuery: jest.Mock, match: RegExp): SqlCall[] =>
  (executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => match.test(sql));

export const paramsOf = (call: SqlCall): Row => Object.fromEntries((call[2] ?? []).map((p) => [p.name, p.value]));

export const post = (value: unknown): HttpRequest =>
  ({ headers: new Headers(), json: async () => value, query: new URLSearchParams() }) as unknown as HttpRequest;

export const get = (query: Record<string, string>): HttpRequest =>
  ({ headers: new Headers(), json: async () => ({}), query: new URLSearchParams(query) }) as unknown as HttpRequest;

export const notJson = (): HttpRequest =>
  ({ headers: new Headers(), json: async () => { throw new SyntaxError("Unexpected token"); }, query: new URLSearchParams() }) as unknown as HttpRequest;

export const errorOf = (response: { jsonBody?: unknown }): string => (response.jsonBody as { error: string }).error;

export const at = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

export const ROW_VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 7]);

/** A DefectsPeriods row joined with its display names. */
export function periodRow(overrides: Row = {}): Row {
  return {
    ArchivedAt: null,
    ArchivedBy: null,
    BuildingId: 1,
    BuildingName: "Tower A",
    ContractorContact: "Sam Builder 0400 000 000",
    ContractorId: 5,
    ContractorName: "Acme Builders",
    CreatedAt: at("2026-07-01"),
    CreatedBy: "Simone",
    DefectsPeriodId: 3,
    EndsOn: at("2027-06-30"),
    Enforcement: "block",
    LevelName: null,
    LocationId: null,
    Notes: null,
    PracticalCompletion: at("2026-06-30"),
    RowVersion: ROW_VERSION,
    Scope: "building",
    Services: '["HVAC / mechanical"]',
    TenantId: null,
    TenantName: null,
    UpdatedAt: at("2026-07-01"),
    UpdatedBy: "Simone",
    Works: "Level 3 mechanical upgrade",
    ...overrides,
  };
}

/** A Jobs row as the coverage query reads it. */
export function jobRow(overrides: Row = {}): Row {
  return {
    BuildingID: 1,
    Category: "HVAC / mechanical",
    JobID: 40,
    Kind: "maintenance",
    LevelName: null,
    Status: "New",
    TenantID: null,
    Title: "Chiller service",
    Type: null,
    ...overrides,
  };
}

/** A ServiceSchedules row joined with its display names (migration 120). */
export function scheduleRow(overrides: Row = {}): Row {
  return {
    Active: true,
    AnchorDate: at("2026-04-28"),
    ArchivedAt: null,
    ArchivedBy: null,
    AssetId: 12,
    AssetName: "Chiller 1",
    AssetTag: "CH-01",
    BuildingId: 1,
    BuildingName: "Tower A",
    Category: "HVAC / mechanical",
    ContractorId: 5,
    ContractorName: "Cool Air Pty Ltd",
    CreatedAt: at("2026-10-01"),
    CreatedBy: "Adam",
    IntervalCount: 6,
    IntervalUnit: "months",
    IsContract: true,
    LastCompletedJobId: null,
    LeadDays: 14,
    LevelLocationId: 30,
    LevelName: "Level 3",
    LocationId: null,
    LocationName: "Plant room",
    Name: "Six-monthly chiller service",
    NextDue: at("2026-10-28"),
    Notes: null,
    RowVersion: ROW_VERSION,
    Scope: null,
    ServiceScheduleId: 21,
    UpdatedAt: at("2026-10-01"),
    UpdatedBy: "Adam",
    ...overrides,
  };
}
