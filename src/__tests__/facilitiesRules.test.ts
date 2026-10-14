/// <reference types="jest" />
import {
  coveringPeriods,
  defectsReminderStage,
  isJobCovered,
  jobService,
  needsLocationChoice,
  type CoverageJob,
  type CoveragePeriod,
} from "../facilitiesRules";
import vectors from "./facilities-rules.vectors.json";

// The same vector file sits in command-centre (src/__tests__/helpers/) and is
// asserted there against the frontend copy of the rules. Change both or neither.

const periods = vectors.periods as unknown as Record<string, CoveragePeriod>;

describe("isJobCovered (shared vectors)", () => {
  it.each(vectors.coverage)("$name", ({ covered, job, period }) => {
    expect(isJobCovered(job as CoverageJob, periods[period], vectors.today)).toBe(covered);
  });
});

describe("needsLocationChoice (shared vectors)", () => {
  it.each(vectors.locationChoice)("$name", ({ ask, job, period }) => {
    expect(needsLocationChoice(job as CoverageJob, periods[period], vectors.today)).toBe(ask);
  });
});

describe("defectsReminderStage (shared vectors)", () => {
  it.each(vectors.reminders)("$name", ({ archived, endsOn, stage, today }) => {
    const period = { ...periods.hvacBuilding, archived, endsOn };
    expect(defectsReminderStage(period, today)).toBe(stage);
  });
});

describe("coveringPeriods", () => {
  it("returns every period that covers the job, earliest end first", () => {
    const job: CoverageJob = {
      buildingId: 1,
      category: "HVAC / mechanical",
      kind: "maintenance",
      levelLocationId: null,
      levelName: "Level 3",
      tenantId: null,
      type: null,
    };
    const result = coveringPeriods(job, [periods.hvacBuilding, periods.allLevel3, periods.archivedBuilding], vectors.today);
    expect(result).toEqual([periods.allLevel3, periods.hvacBuilding]);
  });
});

describe("jobService", () => {
  it("is the category for a maintenance job and the mapped type for a reactive one", () => {
    const base = { buildingId: 1, levelLocationId: null, levelName: null, tenantId: null };
    expect(jobService({ ...base, category: "Lifts", kind: "maintenance", type: "Air Conditioning" })).toBe("Lifts");
    expect(jobService({ ...base, category: "Common Areas", kind: "facilities", type: "Plumbing" })).toBe("Hydraulic");
    expect(jobService({ ...base, category: "Common Areas", kind: "facilities", type: "Signage" })).toBeNull();
    expect(jobService({ ...base, category: "Common Areas", kind: null, type: null })).toBeNull();
  });
});
