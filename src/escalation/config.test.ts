import { chasingOn, sweepSince, sweepSinceProblem } from "./config";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("chasingOn: whether the screens may promise a reminder or a move up", () => {
  it("is true only when the sweep is live", () => {
    expect(chasingOn(env({ ESCALATION_SWEEP_ENABLED: "true" }))).toBe(true);
  });

  it("is false when off, when anything but \"true\", and in a dry run (which writes nothing)", () => {
    expect(chasingOn(env({}))).toBe(false);
    expect(chasingOn(env({ ESCALATION_SWEEP_ENABLED: "1" }))).toBe(false);
    expect(chasingOn(env({ ESCALATION_SWEEP_DRY_RUN: "true", ESCALATION_SWEEP_ENABLED: "true" }))).toBe(false);
  });
});

describe("ESCALATION_SWEEP_SINCE", () => {
  it("is the start of that day in Darwin", () => {
    expect(sweepSince(env({ ESCALATION_SWEEP_SINCE: "2026-11-21" }))?.toISOString()).toBe("2026-11-20T14:30:00.000Z");
  });

  it("is no floor when unset", () => {
    expect(sweepSince(env({}))).toBeNull();
    expect(sweepSinceProblem(env({}))).toBeNull();
  });

  it("is a problem, not a silent no-floor, when set to something that is not a date", () => {
    expect(sweepSince(env({ ESCALATION_SWEEP_SINCE: "21/11/2026" }))).toBeNull();
    expect(sweepSinceProblem(env({ ESCALATION_SWEEP_SINCE: "21/11/2026" }))).toMatch(/not a YYYY-MM-DD date/);
  });
});
