// Shared fakes for the rent review endpoint tests: requests the way Azure
// delivers them, auth through the real requireRole (the dev role header and an
// unsigned JWT, as get-decision-history.test.ts does), rows as tedious returns
// them, and a SQL router for the mocked executeQuery. Nothing here touches a
// clock except todayInDarwin(), so every date is relative to it.

import type { HttpRequest } from "@azure/functions";
import { addDaysIso, addMonthsClamped, todayInDarwin } from "../../darwinDate";

export type Param = { name: string; type?: unknown; value: unknown };
export type Row = Record<string, unknown>;

export const TODAY = todayInDarwin();
export const DAY = (offset: number): string => addDaysIso(TODAY, offset);
export const asDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

export const VERSION_HEX = "0000000000000a01";
export const NEXT_VERSION_HEX = "0000000000000a02";
export const rowVersion = (hex: string): Buffer => Buffer.from(hex, "hex");

function jwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

export function authHeaders(roles: string): Record<string, string> {
  return {
    authorization: `Bearer ${jwt({ name: "Ann Accounts", oid: "oid-ann", preferred_username: "ann@example.com" })}`,
    "x-dev-roles": roles,
  };
}

export function getRequest(query: Record<string, string> | string, roles: string | null = "accounts"): HttpRequest {
  const headers = roles === null ? {} : authHeaders(roles);
  return {
    headers: { get: (key: string) => (headers as Record<string, string>)[key.toLowerCase()] ?? null },
    query: new URLSearchParams(query),
  } as unknown as HttpRequest;
}

export function postRequest(body: unknown, roles: string | null = "accounts"): HttpRequest {
  const headers = roles === null ? {} : authHeaders(roles);
  return {
    headers: { get: (key: string) => (headers as Record<string, string>)[key.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

/** A review as the review queries return it: due, a CPI review dated 10 days out, no owner yet. */
export function reviewRow(over: Row = {}): Row {
  return {
    ApprovalBasis: null,
    ApprovedAt: null,
    ApprovedById: null,
    ApprovedByName: null,
    Basis: null,
    BillingConfirmedAt: null,
    BillingConfirmedBy: null,
    BuildingId: 5,
    Calc: null,
    CreatedAt: new Date("2026-09-01T02:00:00Z"),
    ExpectedIndexAt: null,
    LegalName: "Acme Pty Ltd",
    Method: "cpi",
    NoticeIssuedAt: null,
    NoticeIssuedBy: null,
    NoticeMethod: null,
    OwnerName: null,
    OwnerUserId: null,
    PreparedAt: null,
    PreparedById: null,
    PreparedByName: null,
    ReviewId: "rev-1",
    ReviewType: "cpi",
    ScheduledFor: asDate(DAY(10)),
    State: "due",
    Status: "due",
    StepId: null,
    SubmittedAt: null,
    TenantBuildingId: 5,
    TenantId: 7,
    TenantStatus: "current",
    TradingName: null,
    UpdatedAt: new Date("2026-09-01T02:00:00Z"),
    Version: rowVersion(VERSION_HEX),
    WaiveReason: null,
    ...over,
  };
}

/** A tenancy as store.loadTenancyForReview returns it: a Darwin CPI lease with a cap, a floor and a ratchet. */
export function tenancyRow(over: Row = {}): Row {
  return {
    BuildingId: 5,
    BuildingName: "Tower A",
    Commencement: asDate(addMonthsClamped(DAY(10), -24)),
    CpiCapPercent: 5,
    CpiFloorPercent: 1,
    CpiRegion: "DARWIN",
    Expiry: asDate(addMonthsClamped(DAY(10), 36)),
    FixedReviewPercent: null,
    LastReviewDate: asDate(addMonthsClamped(DAY(10), -12)),
    LegalName: "Acme Pty Ltd",
    RentPerAnnum: 120000,
    ReviewIntervalMonths: 12,
    ReviewRatchet: true,
    ReviewType: "CPI Darwin (June)",
    ScheduleVersion: 4,
    ScheduledRateSteps: null,
    Status: "current",
    TenantId: 7,
    TradingName: null,
    ...over,
  };
}

type Route = [RegExp, (params: Param[], sql: string) => Row[] | Promise<Row[]>];

/** Answers the mocked executeQuery by matching the SQL text; anything unmatched fails the test loudly. */
export function routeSql(mock: { mockImplementation: (fn: (...args: any[]) => unknown) => unknown }, routes: Route[]): void {
  mock.mockImplementation(async (_connection: unknown, sql: string, params: Param[] = []) => {
    for (const [pattern, answer] of routes) {
      if (pattern.test(sql)) return answer(params, sql);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

export const paramsOf = (params: Param[] = []): Record<string, unknown> =>
  Object.fromEntries(params.map((param) => [param.name, param.value]));

/** The [connection, sql, params] of every call whose SQL matches. */
export function callsMatching(
  mock: { mock: { calls: unknown[][] } },
  pattern: RegExp,
): Array<{ params: Record<string, unknown>; sql: string }> {
  return mock.mock.calls
    .filter((call) => typeof call[1] === "string" && pattern.test(call[1]))
    .map((call) => ({ params: paramsOf(call[2] as Param[] | undefined), sql: call[1] as string }));
}

/** The decision-ledger rows the real record() sent, as they would be stored. */
export function ledgerRowsOf(mock: { mock: { calls: unknown[][] } }) {
  return callsMatching(mock, /INSERT INTO dbo\.DecisionLedger/).map(({ params: p }) => {
    const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : null);
    return {
      action: p.Action as string,
      actorKind: p.ActorKind,
      actorName: p.ActorName,
      actorRole: p.ActorRole,
      actorUserId: p.ActorUserId,
      after: json(p.After) as Record<string, unknown> | null,
      before: json(p.Before) as Record<string, unknown> | null,
      buildingId: p.BuildingId as number | null,
      isException: p.IsException,
      reason: p.Reason as string | null,
      ruleApplied: p.RuleApplied as string | null,
      subjectId: p.SubjectId as string,
      subjectType: p.SubjectType as string,
      tenantId: p.TenantId as number | null,
    };
  });
}
