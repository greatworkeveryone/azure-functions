/// <reference types="jest" />
import { DAILY_SECONDS_CAP, HEARTBEAT_GRACE_SECONDS, allowanceSince, limitPerDay, scaleToAllowance, sessionAllowance } from "./clamp";
import type { UsageViewInput } from "./validate";

const view = (seq: number, seconds: number, at = "2026-10-24T01:00:00Z"): UsageViewInput => ({ activeSeconds: seconds, continued: false, enteredAt: new Date(at), module: "jobs", route: "/jobs", seq });
const total = (views: UsageViewInput[]) => views.reduce((sum, item) => sum + item.activeSeconds, 0);

describe("allowanceSince", () => {
  it("is the time since the last heartbeat plus a minute's grace, and never negative", () => {
    expect(HEARTBEAT_GRACE_SECONDS).toBe(60);
    expect(allowanceSince(new Date("2026-10-24T01:00:00Z"), new Date("2026-10-24T01:00:45Z"))).toBe(105);
    expect(allowanceSince(new Date("2026-10-24T01:00:30Z"), new Date("2026-10-24T01:00:00Z"))).toBe(60);
  });
});

describe("sessionAllowance", () => {
  const started = new Date("2026-10-24T01:00:00Z");

  it("is the time since the last heartbeat plus a minute for a session keeping pace", () => {
    expect(sessionAllowance({ activeSeconds: 600, lastHeartbeatAt: new Date("2026-10-24T01:10:00Z"), startedAt: started }, new Date("2026-10-24T01:10:45Z"))).toBe(105);
  });

  it("stops many small batches each earning a new minute: the session's total may not pass its age plus a minute", () => {
    const session = { activeSeconds: 600, lastHeartbeatAt: new Date("2026-10-24T01:10:44Z"), startedAt: started };
    const now = new Date("2026-10-24T01:10:45Z");
    expect(sessionAllowance(session, now)).toBe(61);
    expect(sessionAllowance({ ...session, activeSeconds: 700 }, now)).toBe(5);
    expect(sessionAllowance({ ...session, activeSeconds: 705 }, now)).toBe(0);
    expect(sessionAllowance({ ...session, activeSeconds: 900 }, now)).toBe(0);
  });
});

describe("scaleToAllowance", () => {
  it("leaves a batch within its allowance alone", () => {
    const views = [view(1, 40), view(2, 20)];
    expect(scaleToAllowance(views, 105)).toEqual(views);
  });

  it("scales every view down, in proportion, so the batch fits and never grows", () => {
    const scaled = scaleToAllowance([view(1, 900), view(2, 900)], 120);
    expect(total(scaled)).toBeLessThanOrEqual(120);
    expect(total(scaled)).toBeGreaterThan(110);
    expect(scaled[0].activeSeconds).toBe(scaled[1].activeSeconds);
  });

  it("gives nothing when there is no allowance", () => {
    expect(total(scaleToAllowance([view(1, 500)], 0))).toBe(0);
  });
});

describe("limitPerDay", () => {
  it("keeps a person's day inside 24 hours across every session: only what is left of the day may be added", () => {
    const limited = limitPerDay([view(1, 900)], new Map([["2026-10-24", DAILY_SECONDS_CAP - 300]]));
    expect(total(limited)).toBe(300);
  });

  it("adds nothing to a day that is already full", () => {
    expect(total(limitPerDay([view(1, 900)], new Map([["2026-10-24", DAILY_SECONDS_CAP]])))).toBe(0);
  });

  it("treats each Darwin day on its own", () => {
    const views = [view(1, 600, "2026-10-24T01:00:00Z"), view(2, 600, "2026-10-24T20:00:00Z")];
    const limited = limitPerDay(views, new Map([["2026-10-24", DAILY_SECONDS_CAP], ["2026-10-25", 0]]));
    expect(limited.map((item) => item.activeSeconds)).toEqual([0, 600]);
  });
});
