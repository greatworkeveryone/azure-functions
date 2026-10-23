/// <reference types="jest" />
import { jobPath } from "../jobLinks";
import { isSafeAppRoute, teamsTabLink } from "./deepLink";

const APP_ID = "11111111-2222-3333-4444-555555555555";

describe("isSafeAppRoute (mirrored by FE src/lib/teams/appRoute.ts)", () => {
  it.each([
    "/dashboard",
    "/jobs?jobId=1&step=decision",
    "/jobs?jobId=12&step=decision&decisionRequestId=4#decision",
    "/tenancy/42",
    "/tenancy/reviews/RR-1",
    "/maintenance?scheduleId=7",
    "/escalations",
  ])("accepts %s", (route) => {
    expect(isSafeAppRoute(route)).toBe(true);
  });

  it("accepts every job link jobPath builds", () => {
    expect(isSafeAppRoute(jobPath(12, { quoteId: 3, step: "quotes" }))).toBe(true);
    expect(isSafeAppRoute(jobPath(12, { decisionRequestId: 9, step: "decision" }))).toBe(true);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/jobs"],
    ["backslash", "/\\evil.com"],
    ["backslash later", "/jobs\\..\\admin"],
    ["absolute URL", "https://x"],
    ["javascript scheme", "javascript:alert(1)"],
    ["scheme after slash", "/javascript:alert(1)"],
    ["control char", "/jobs\n"],
    ["tab", "/jobs\t?jobId=1"],
    ["NUL", "/jobs\u0000"],
    ["dot segment", "/jobs/../admin/users"],
    ["encoded dot segment", "/jobs/%2e%2e/admin"],
    ["not on the allow-list", "/admin/users"],
    ["prefix lookalike", "/jobsevil"],
    ["empty", ""],
    ["relative", "jobs"],
  ])("refuses %s", (_label, route) => {
    expect(isSafeAppRoute(route)).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isSafeAppRoute(null)).toBe(false);
    expect(isSafeAppRoute(42)).toBe(false);
  });
});

describe("teamsTabLink", () => {
  it("encodes the route as subEntityId in the context parameter", () => {
    const route = "/jobs?jobId=1&step=decision#decision";
    const link = teamsTabLink(APP_ID, route);
    expect(link.startsWith(`https://teams.microsoft.com/l/entity/${APP_ID}/floorplan?context=`)).toBe(true);
    const context = new URL(link).searchParams.get("context");
    expect(JSON.parse(context ?? "")).toEqual({ subEntityId: route });
    // Nothing from the route survives unencoded into the outer URL.
    expect(link).not.toMatch(/[&#"{}]/);
  });

  it("throws on an unsafe route", () => {
    expect(() => teamsTabLink(APP_ID, "//evil.com")).toThrow(/Unsafe Teams deep-link route/);
  });
});
