import {
  assignedContractorIds,
  buildFeatureVector,
  canonicalTrade,
  certificateState,
  EXPIRING_WITHIN_DAYS,
  FEATURE_SCHEMA_VERSION,
  knownServiceRegion,
  quoteFigures,
  twelveMonthsAgo,
  type CertificateRecord,
  type Engagement,
  type FeatureInputs,
} from "./features";

const TODAY = "2026-10-23";
const SINCE = twelveMonthsAgo(TODAY);
const day = (iso: string) => new Date(`${iso}T03:00:00Z`);

const cert = (patch: Partial<CertificateRecord> = {}): CertificateRecord => ({
  buildingId: null,
  expiresOn: "2027-06-30",
  insuranceType: "Public liability",
  issuedOn: "2026-01-01",
  ...patch,
});

const job = (jobId: number, patch: Partial<Engagement> = {}): Engagement => ({
  buildingId: 10,
  category: "Electrical",
  createdAt: day("2026-08-01"),
  doneAt: null,
  jobId,
  ...patch,
});

function inputs(patch: Partial<FeatureInputs> = {}): FeatureInputs {
  return {
    assignedToBuilding: false,
    buildingId: 10,
    buildingRegion: "Darwin",
    certificates: [cert()],
    engagements: [],
    profile: null,
    quoteStatuses: [],
    since: SINCE,
    today: TODAY,
    trade: "Electrical",
    ...patch,
  };
}

describe("the schema version", () => {
  it("is the one the log and the evaluation key on", () => {
    expect(FEATURE_SCHEMA_VERSION).toBe("cs-features@1");
  });
});

describe("canonicalTrade", () => {
  it("returns the canonical spelling of a servicing trade, whatever the case", () => {
    expect(canonicalTrade("electrical")).toBe("Electrical");
    expect(canonicalTrade(" HVAC / mechanical ")).toBe("HVAC / mechanical");
  });

  it("is null for the reactive categories and for nothing", () => {
    expect(canonicalTrade("Common Areas")).toBeNull();
    expect(canonicalTrade("Tenancy Works")).toBeNull();
    expect(canonicalTrade("")).toBeNull();
    expect(canonicalTrade(null)).toBeNull();
  });
});

describe("knownServiceRegion", () => {
  it("accepts only the three confirmed service regions, whatever the case", () => {
    expect(knownServiceRegion("darwin")).toBe("Darwin");
    expect(knownServiceRegion(" Palmerston")).toBe("Palmerston");
    expect(knownServiceRegion("Katherine")).toBe("Katherine");
  });

  it("does not turn the source's NT, an address or nothing into a region", () => {
    expect(knownServiceRegion("NT")).toBeNull();
    expect(knownServiceRegion("Darwin CBD")).toBeNull();
    expect(knownServiceRegion(null)).toBeNull();
  });
});

describe("twelveMonthsAgo", () => {
  it("opens the window at midnight in Darwin, twelve calendar months back", () => {
    expect(twelveMonthsAgo("2026-10-23").toISOString()).toBe("2025-10-22T14:30:00.000Z");
  });

  it("clamps a leap day", () => {
    expect(twelveMonthsAgo("2028-02-29").toISOString()).toBe("2027-02-27T14:30:00.000Z");
  });
});

describe("certificateState", () => {
  it("is missing when none is recorded for the contractor", () => {
    expect(certificateState([], 10, TODAY)).toEqual({ daysToExpiry: null, status: "missing" });
  });

  it("is valid when the expiry is beyond 30 days, with the days to it", () => {
    expect(certificateState([cert({ expiresOn: "2026-12-31" })], 10, TODAY)).toEqual({ daysToExpiry: 69, status: "valid" });
  });

  it(`is expiring from ${EXPIRING_WITHIN_DAYS} days out down to today`, () => {
    expect(certificateState([cert({ expiresOn: "2026-11-22" })], 10, TODAY)).toEqual({ daysToExpiry: 30, status: "expiring" });
    expect(certificateState([cert({ expiresOn: "2026-11-23" })], 10, TODAY).status).toBe("valid");
    expect(certificateState([cert({ expiresOn: TODAY })], 10, TODAY)).toEqual({ daysToExpiry: 0, status: "expiring" });
  });

  it("is expired once the expiry has passed, with negative days", () => {
    expect(certificateState([cert({ expiresOn: "2026-10-15" })], 10, TODAY)).toEqual({ daysToExpiry: -8, status: "expired" });
  });

  it("is unknown when a certificate is on record without an expiry", () => {
    expect(certificateState([cert({ expiresOn: null })], 10, TODAY)).toEqual({ daysToExpiry: null, status: "unknown" });
  });

  it("ignores a certificate scoped to another building but counts a portfolio-wide one", () => {
    expect(certificateState([cert({ buildingId: 11 })], 10, TODAY).status).toBe("missing");
    expect(certificateState([cert({ buildingId: 10 })], 10, TODAY).status).toBe("valid");
    expect(certificateState([cert({ buildingId: null })], 10, TODAY).status).toBe("valid");
  });

  it("lets a renewal supersede an old certificate of the same type", () => {
    const old = cert({ expiresOn: "2026-09-30", issuedOn: "2025-10-01" });
    const renewal = cert({ expiresOn: "2027-09-30", issuedOn: "2026-10-01" });
    expect(certificateState([old, renewal], 10, TODAY).status).toBe("valid");
  });

  it("does not count a certificate that is not in effect yet", () => {
    expect(certificateState([cert({ issuedOn: "2026-12-01" })], 10, TODAY).status).toBe("missing");
  });

  it("takes the worst insurance type, and the earliest expiry among those dated", () => {
    const liability = cert({ expiresOn: "2026-11-02", insuranceType: "Public liability" });
    const workers = cert({ expiresOn: "2027-08-01", insuranceType: "Workers compensation" });
    expect(certificateState([liability, workers], 10, TODAY)).toEqual({ daysToExpiry: 10, status: "expiring" });
    const lapsed = cert({ expiresOn: "2026-10-01", insuranceType: "Workers compensation" });
    expect(certificateState([liability, lapsed], 10, TODAY)).toEqual({ daysToExpiry: -22, status: "expired" });
  });
});

describe("quoteFigures", () => {
  it("counts approved and completed as accepted and rejected as the rest of the decided", () => {
    expect(quoteFigures(["approved", "completed", "rejected", "rejected"])).toEqual({ accepted: 2, decided: 4, rate: 0.5 });
  });

  it("leaves pending and in-approval quotes out: they have not been decided", () => {
    expect(quoteFigures(["pending", "awaiting_approval", "awaiting_director"])).toEqual({ accepted: 0, decided: 0, rate: null });
  });

  it("is null when there are no quotes at all", () => {
    expect(quoteFigures([]).rate).toBeNull();
  });

  it("rounds the rate to three places", () => {
    expect(quoteFigures(["approved", "rejected", "rejected"]).rate).toBe(0.333);
  });
});

describe("assignedContractorIds", () => {
  const plan = [
    { contractorIds: [4, 5], required: true, trade: "Electrical" },
    { contractorIds: [6], required: false, trade: "Lifts" },
  ];

  it("names the contractors the plan gives this trade, case-insensitively", () => {
    expect([...assignedContractorIds(plan, "electrical")]).toEqual([4, 5]);
  });

  it("names nobody for another trade, a missing plan, a missing trade or a broken row", () => {
    expect(assignedContractorIds(plan, "Cleaning").size).toBe(0);
    expect(assignedContractorIds(null, "Electrical").size).toBe(0);
    expect(assignedContractorIds(plan, null).size).toBe(0);
    expect(assignedContractorIds([null, { trade: 5 }, { contractorIds: "x", trade: "Electrical" }], "Electrical").size).toBe(0);
  });
});

describe("buildFeatureVector", () => {
  it("reads gaps in what was recorded as unknown, never as no", () => {
    const vector = buildFeatureVector(inputs({ certificates: [], profile: null }));
    expect(vector.tradeCovered).toBeNull();
    expect(vector.regionMatch).toBeNull();
    expect(vector.certificateStatus).toBe("missing");
    expect(vector.daysSinceLastJobHere).toBeNull();
    expect(vector.quoteAcceptanceRate12m).toBeNull();
    expect(vector.medianDaysToComplete12m).toBeNull();
  });

  it("treats a profile with no trades or no regions as unrecorded too", () => {
    const vector = buildFeatureVector(inputs({ profile: { regions: [], trades: [] } }));
    expect(vector.tradeCovered).toBeNull();
    expect(vector.regionMatch).toBeNull();
  });

  it("matches trade and region against what the contractor confirmed", () => {
    const covered = buildFeatureVector(inputs({ profile: { regions: ["Darwin", "Palmerston"], trades: ["electrical"] } }));
    expect(covered.tradeCovered).toBe(true);
    expect(covered.regionMatch).toBe(true);
    const other = buildFeatureVector(inputs({ profile: { regions: ["Katherine"], trades: ["Lifts"] } }));
    expect(other.tradeCovered).toBe(false);
    expect(other.regionMatch).toBe(false);
  });

  it("does not guess when the job's trade or the building's region is unknown", () => {
    const vector = buildFeatureVector(inputs({ buildingRegion: null, profile: { regions: ["Darwin"], trades: ["Electrical"] }, trade: null }));
    expect(vector.tradeCovered).toBeNull();
    expect(vector.regionMatch).toBeNull();
    expect(vector.jobsTrade12m).toBe(0);
  });

  it("is assigned only for a trade", () => {
    expect(buildFeatureVector(inputs({ assignedToBuilding: true })).assignedToBuilding).toBe(true);
    expect(buildFeatureVector(inputs({ assignedToBuilding: true, trade: null })).assignedToBuilding).toBe(false);
  });

  it("counts jobs at this building and in this trade within the twelve months, once per job", () => {
    const vector = buildFeatureVector(
      inputs({
        engagements: [
          job(1),
          job(1),
          job(2, { createdAt: day("2026-02-01") }),
          job(3, { buildingId: 11 }),
          job(4, { buildingId: 11, category: "Lifts" }),
          job(5, { createdAt: day("2025-01-01") }),
        ],
      }),
    );
    expect(vector.jobsHere12m).toBe(2);
    expect(vector.jobsTrade12m).toBe(3);
  });

  it("reaches back past the window for the last job here, in whole days, never negative", () => {
    const old = buildFeatureVector(inputs({ engagements: [job(5, { createdAt: day("2024-10-23") })] }));
    expect(old.jobsHere12m).toBe(0);
    expect(old.daysSinceLastJobHere).toBe(730);
    const latest = buildFeatureVector(inputs({ engagements: [job(1, { createdAt: day("2026-10-13") }), job(2, { createdAt: day("2026-05-01") })] }));
    expect(latest.daysSinceLastJobHere).toBe(10);
    const future = buildFeatureVector(inputs({ engagements: [job(1, { createdAt: day("2026-10-30") })] }));
    expect(future.daysSinceLastJobHere).toBe(0);
  });

  it("takes the median days to complete over jobs done in the window, from any building", () => {
    const done = (jobId: number, created: string, doneAt: string, buildingId = 10) => job(jobId, { buildingId, createdAt: day(created), doneAt: day(doneAt) });
    const vector = buildFeatureVector(
      inputs({
        engagements: [
          done(1, "2026-09-01", "2026-09-05"),
          done(2, "2026-08-01", "2026-08-11", 11),
          done(3, "2026-07-01", "2026-07-03"),
          done(4, "2024-01-01", "2024-02-01"),
          job(5),
        ],
      }),
    );
    expect(vector.medianDaysToComplete12m).toBe(4);
  });

  it("averages the middle two when an even number of jobs were done", () => {
    const vector = buildFeatureVector(
      inputs({
        engagements: [
          job(1, { createdAt: day("2026-09-01"), doneAt: day("2026-09-03") }),
          job(2, { createdAt: day("2026-09-01"), doneAt: day("2026-09-08") }),
        ],
      }),
    );
    expect(vector.medianDaysToComplete12m).toBe(4.5);
  });

  it("carries the quote figures and the certificate reading", () => {
    const vector = buildFeatureVector(inputs({ certificates: [cert({ expiresOn: "2026-11-04" })], quoteStatuses: ["approved", "rejected", "approved"] }));
    expect(vector).toMatchObject({
      certificateDaysToExpiry: 12,
      certificateStatus: "expiring",
      quoteAcceptanceRate12m: 0.667,
      quotesAccepted12m: 2,
      quotesDecided12m: 3,
    });
  });

  it("has exactly the fields of cs-features@1", () => {
    expect(Object.keys(buildFeatureVector(inputs())).sort()).toEqual([
      "assignedToBuilding",
      "certificateDaysToExpiry",
      "certificateStatus",
      "daysSinceLastJobHere",
      "jobsHere12m",
      "jobsTrade12m",
      "medianDaysToComplete12m",
      "quoteAcceptanceRate12m",
      "quotesAccepted12m",
      "quotesDecided12m",
      "regionMatch",
      "tradeCovered",
    ]);
  });
});
