/// <reference types="jest" />
import { readTimer, MAX_GAP_MINUTES, TIMERS_WITHOUT_GAP } from "./timerStaleness";
import { healthSwitches } from "./switches";
import { TIMER_NAMES } from "../timerRuns";

const run = (startedAt: string) => ({ error: null, finishedAt: startedAt, outcome: "ok", startedAt });
const now = new Date("2026-11-21T12:00:00Z");

describe("timer staleness", () => {
  it("every registered timer has a stated gap", () => {
    expect(TIMERS_WITHOUT_GAP).toEqual([]);
    expect(Object.keys(MAX_GAP_MINUTES).sort()).toEqual([...TIMER_NAMES].sort());
  });

  it("a 30 minute timer that last ran 3 hours ago is stale; 1 hour ago is not", () => {
    expect(readTimer("escalationSweepTimer", run("2026-11-21T09:00:00Z"), now).stale).toBe(true);
    expect(readTimer("escalationSweepTimer", run("2026-11-21T11:00:00Z"), now).stale).toBe(false);
  });

  it("a daily timer is stale after two days, not after one", () => {
    expect(readTimer("schedulerTimer", run("2026-11-20T11:00:00Z"), now).stale).toBe(false);
    expect(readTimer("schedulerTimer", run("2026-11-18T11:00:00Z"), now).stale).toBe(true);
  });

  it("a timer that never ran is not stale, it says so by having no last run", () => {
    const reading = readTimer("schedulerTimer", null, now);
    expect(reading.stale).toBe(false);
    expect(reading.lastRun).toBeNull();
  });
});

describe("health switches", () => {
  it("reports the behaviour switches and no values", () => {
    const s = healthSwitches({
      AZURE_FUNCTIONS_ENVIRONMENT: "Staging",
      DIGEST_ENABLED: "true",
      ESCALATION_SWEEP_DRY_RUN: "true",
      ESCALATION_SWEEP_SINCE: "2026-12-07",
      GRAPH_CLIENT_SECRET: "super-secret",
      MYBUILDINGS_BEARER_TOKEN: "token",
    });
    expect(s).toEqual({
      digest: "live",
      environment: "Staging",
      escalationSweep: { mode: "dry-run", since: "2026-12-07" },
      mybuildingsContractorPush: false,
      mybuildingsSync: true,
      privilegedGrantTwoPerson: true,
      stagingGuardActive: true,
    });
    expect(JSON.stringify(s)).not.toMatch(/secret|token/i);
  });

  it("production with the push and sync switched off says so", () => {
    const s = healthSwitches({ AZURE_FUNCTIONS_ENVIRONMENT: "Production", MYBUILDINGS_CONTRACTOR_PUSH: "false", MYBUILDINGS_SYNC_ENABLED: "false" });
    expect(s.mybuildingsContractorPush).toBe(false);
    expect(s.mybuildingsSync).toBe(false);
    expect(s.stagingGuardActive).toBe(false);
    expect(s.digest).toBe("off");
  });
});
