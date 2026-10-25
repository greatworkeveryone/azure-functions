/// <reference types="jest" />
import { MAX_BATCH_SECONDS, MAX_VIEWS_PER_BATCH, parseUsageBatch } from "./validate";

const NOW = new Date("2026-10-24T03:00:00.000Z");
const view = (over: Record<string, unknown> = {}) => ({ activeSeconds: 30, enteredAt: "2026-10-24T02:59:00.000Z", module: "jobs", route: "/jobs/[id]", seq: 1, ...over });
const body = (over: Record<string, unknown> = {}) => ({
  device: { browser: "Safari", class: "phone", id: "d_abcdefghijklmnop1", os: "iOS" },
  sessionId: "x_abcdefghijklmnop1",
  views: [view()],
  ...over,
});
const error = (value: unknown) => {
  const parsed = parseUsageBatch(value, NOW);
  return "error" in parsed ? parsed.error : null;
};

describe("parseUsageBatch", () => {
  it("accepts a well-formed batch and says whether the device id is kept in storage", () => {
    const parsed = parseUsageBatch(body(), NOW);
    expect("batch" in parsed && parsed.batch.device).toEqual({ browser: "Safari", class: "phone", id: "d_abcdefghijklmnop1", osFamily: "iOS", persistent: true });
    const session = parseUsageBatch(body({ device: { browser: "Safari", class: "phone", id: "s_abcdefghijklmnop1", os: "iOS" } }), NOW);
    expect("batch" in session && session.batch.device.persistent).toBe(false);
  });

  it.each([
    ["a number segment (an id)", "/jobs/123"],
    ["a uuid segment", "/jobs/3f2b8c1e-aaaa-bbbb-cccc-123456789012"],
    ["a query string", "/jobs?status=open"],
    ["a hash", "/jobs#top"],
    ["no leading slash", "jobs"],
    ["an upper-case segment", "/Jobs"],
    ["a double slash", "//jobs"],
    ["a trailing slash", "/jobs/"],
    ["a very long route", `/${"a".repeat(130)}`],
  ])("refuses a route with %s", (_label, route) => {
    expect(error(body({ views: [view({ route })] }))).toMatch(/route pattern/);
  });

  it("accepts the root and bracketed placeholders", () => {
    expect(error(body({ views: [view({ route: "/" })] }))).toBeNull();
    expect(error(body({ views: [view({ route: "/tenancy/reviews/[reviewId]" })] }))).toBeNull();
  });

  it.each(["Jobs", "jobs/12", "jobs?x=1", "a/b/c/d", "", "*"])("refuses the module key %p", (module) => {
    expect(error(body({ views: [view({ module })] }))).toMatch(/module key/);
  });

  it("accepts navigation module keys with a slash or hyphen", () => {
    for (const module of ["jobs", "admin/myob", "tools/email-broadcast", "audit-log"]) expect(error(body({ views: [view({ module })] }))).toBeNull();
  });

  it("caps views, seconds and the size of a batch", () => {
    const many = Array.from({ length: MAX_VIEWS_PER_BATCH + 1 }, (_, i) => view({ activeSeconds: 1, seq: i + 1 }));
    expect(error(body({ views: many }))).toMatch(/1 to 20/);
    expect(error(body({ views: [view({ activeSeconds: 901 })] }))).toMatch(/activeSeconds/);
    expect(error(body({ views: [view({ activeSeconds: -1 })] }))).toMatch(/activeSeconds/);
    expect(error(body({ views: [view({ activeSeconds: 1.5 })] }))).toMatch(/activeSeconds/);
    const heavy = [view({ activeSeconds: 900, seq: 1 }), view({ activeSeconds: 900, seq: 2 }), view({ activeSeconds: 1, seq: 3 })];
    expect(heavy.reduce((sum, v) => sum + v.activeSeconds, 0)).toBeGreaterThan(MAX_BATCH_SECONDS);
    expect(error(body({ views: heavy }))).toMatch(/at most 1800/);
  });

  it("refuses a time far from now, a repeated seq and a bad device or session", () => {
    expect(error(body({ views: [view({ enteredAt: "2026-10-22T00:00:00.000Z" })] }))).toMatch(/too far/);
    expect(error(body({ views: [view({ enteredAt: "2026-10-24T04:00:00.000Z" })] }))).toMatch(/too far/);
    expect(error(body({ views: [view({ enteredAt: "nope" })] }))).toMatch(/enteredAt/);
    expect(error(body({ views: [view(), view()] }))).toMatch(/different/);
    expect(error(body({ sessionId: "abc" }))).toMatch(/sessionId/);
    expect(error(body({ device: { browser: "Safari", class: "phone", id: "xyz", os: "iOS" } }))).toMatch(/device.id/);
    expect(error(body({ device: { browser: "Safari", class: "watch", id: "d_abcdefghijklmnop1", os: "iOS" } }))).toMatch(/device.class/);
    expect(error(body({ device: { browser: "Safari 17.2.1", class: "phone", id: "d_abcdefghijklmnop1", os: "iOS" } }))).toMatch(/browser/);
    expect(error(body({ device: { browser: "Safari", class: "phone", id: "d_abcdefghijklmnop1", os: "iOS 17.1" } }))).toMatch(/operating system/);
  });

  it("refuses anything that is not an object", () => {
    for (const value of [null, "x", 5, [], undefined]) expect(error(value)).toMatch(/JSON object/);
  });

  it("keeps only the fields it knows: nothing else the browser sends reaches the batch", () => {
    const parsed = parseUsageBatch(body({ typed: "secret", userId: 1, views: [view({ title: "Tenant Smith", text: "hello" })] }), NOW);
    expect(JSON.stringify("batch" in parsed ? parsed.batch : parsed)).not.toMatch(/secret|Tenant Smith|hello|userId/);
  });
});
