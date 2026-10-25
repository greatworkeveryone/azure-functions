/// <reference types="jest" />
import { DIGEST_CRON, digestRunDecision } from "./schedule";

const NO_HOLIDAYS = {} as NodeJS.ProcessEnv;
const at = (iso: string) => new Date(iso);

describe("the schedule", () => {
  it("fires at 22:00 UTC Sunday to Thursday, which is 07:30 Darwin Monday to Friday", () => {
    expect(DIGEST_CRON).toBe("0 0 22 * * 0-4");
    // Darwin is UTC+09:30 all year, so 22:00 UTC is 07:30 the next morning.
    const sundayUtc = at("2026-10-18T22:00:00Z");
    expect(sundayUtc.getUTCDay()).toBe(0);
    const decision = digestRunDecision(sundayUtc, NO_HOLIDAYS);
    expect(decision).toEqual({ darwinDate: "2026-10-19", run: true });
  });

  it("covers every business day of the week once", () => {
    const fires = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map(
      (utcDay) => digestRunDecision(at(`${utcDay}T22:00:00Z`), NO_HOLIDAYS),
    );
    expect(fires).toEqual([
      { darwinDate: "2026-10-12", run: true }, // Monday
      { darwinDate: "2026-10-13", run: true },
      { darwinDate: "2026-10-14", run: true },
      { darwinDate: "2026-10-15", run: true },
      { darwinDate: "2026-10-16", run: true }, // Friday
    ]);
  });
});

describe("business days, by the Darwin calendar", () => {
  it("uses the Darwin date, not the UTC date (Tuesday 22:00 UTC is already Wednesday in Darwin)", () => {
    const instant = at("2026-10-13T22:00:00Z");
    expect(instant.getUTCDay()).toBe(2);
    expect(digestRunDecision(instant, NO_HOLIDAYS)).toEqual({ darwinDate: "2026-10-14", run: true });
  });

  it("does not run on a Darwin Saturday or Sunday", () => {
    expect(digestRunDecision(at("2026-10-16T22:00:00Z"), NO_HOLIDAYS)).toEqual({ darwinDate: "2026-10-17", reason: "weekend", run: false });
    expect(digestRunDecision(at("2026-10-17T22:00:00Z"), NO_HOLIDAYS)).toEqual({ darwinDate: "2026-10-18", reason: "weekend", run: false });
  });

  it("does not run on a public holiday listed in ESCALATION_HOLIDAYS (Darwin dates)", () => {
    const env = { ESCALATION_HOLIDAYS: "2026-12-25, 2026-10-14" } as NodeJS.ProcessEnv;
    expect(digestRunDecision(at("2026-10-13T22:00:00Z"), env)).toEqual({ darwinDate: "2026-10-14", reason: "holiday", run: false });
    expect(digestRunDecision(at("2026-10-14T22:00:00Z"), env)).toEqual({ darwinDate: "2026-10-15", run: true });
  });

  it("ignores holiday entries that are not real dates", () => {
    const env = { ESCALATION_HOLIDAYS: "tomorrow,2026-02-30" } as NodeJS.ProcessEnv;
    expect(digestRunDecision(at("2026-10-13T22:00:00Z"), env).run).toBe(true);
  });
});

describe("the morning window (07:00 to 12:00 Darwin)", () => {
  it("runs when the timer fires on time", () => {
    expect(digestRunDecision(at("2026-10-13T22:00:00Z"), NO_HOLIDAYS).run).toBe(true);
  });

  it("runs when the host was a little late", () => {
    expect(digestRunDecision(at("2026-10-14T01:29:00Z"), NO_HOLIDAYS).run).toBe(true); // 10:59 Darwin
  });

  it("does not send a morning digest at lunchtime or later (a missed run catching up after a restart)", () => {
    expect(digestRunDecision(at("2026-10-14T02:30:00Z"), NO_HOLIDAYS)).toEqual({ darwinDate: "2026-10-14", reason: "too_late", run: false }); // 12:00 Darwin
    expect(digestRunDecision(at("2026-10-14T08:00:00Z"), NO_HOLIDAYS).run).toBe(false); // 17:30 Darwin
  });

  it("does not run before 07:00", () => {
    expect(digestRunDecision(at("2026-10-13T21:29:00Z"), NO_HOLIDAYS)).toEqual({ darwinDate: "2026-10-14", reason: "too_early", run: false }); // 06:59 Darwin
  });
});
