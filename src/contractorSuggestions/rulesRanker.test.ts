import { buildFeatureVector, type FeatureInputs } from "./features";
import { componentsFor, hasEvidence, MAX_POSITIVE_REASONS, RULES_V1_WEIGHTS, rulesRanker } from "./rulesRanker";
import type { Candidate, FeatureVector, SuggestionContext } from "./types";

const context: SuggestionContext = {
  buildingId: 10,
  buildingRegion: "Darwin",
  context: "quote_request",
  jobId: 7,
  today: "2026-10-23",
  trade: "Electrical",
};

/** A contractor nothing is recorded about, apart from a valid certificate. */
const blank: FeatureVector = {
  assignedToBuilding: false,
  certificateDaysToExpiry: 200,
  certificateStatus: "valid",
  daysSinceLastJobHere: null,
  jobsHere12m: 0,
  jobsTrade12m: 0,
  medianDaysToComplete12m: null,
  quoteAcceptanceRate12m: null,
  quotesAccepted12m: 0,
  quotesDecided12m: 0,
  regionMatch: null,
  tradeCovered: null,
};

const features = (patch: Partial<FeatureVector>): FeatureVector => ({ ...blank, ...patch });
const candidate = (contractorId: number, name: string, patch: Partial<FeatureVector>): Candidate => ({ contractorId, features: features(patch), name });
const texts = (reasons: { text: string }[]) => reasons.map((reason) => reason.text);

describe("rules@1", () => {
  it("is versioned", () => {
    expect(rulesRanker.version).toBe("rules@1");
  });

  it("documents its weights and keeps the strongest explicit statement strongest", () => {
    const w = RULES_V1_WEIGHTS;
    expect(w.assignedToBuilding).toBeGreaterThan(w.tradeCovered);
    expect(w.tradeCovered).toBeGreaterThan(w.maxJobsHere * w.perJobHere - 1);
    expect(w.maxJobsHere * w.perJobHere).toBeGreaterThan(w.maxJobsTrade * w.perJobTrade);
    expect(w.certificate.expired).toBeLessThan(w.certificate.missing);
    expect(w.certificate.missing).toBeLessThan(w.certificate.expiring);
  });
});

describe("evidence", () => {
  it("needs an assignment, a confirmed trade, or recent work", () => {
    expect(hasEvidence(features({ assignedToBuilding: true }))).toBe(true);
    expect(hasEvidence(features({ tradeCovered: true }))).toBe(true);
    expect(hasEvidence(features({ jobsHere12m: 1 }))).toBe(true);
    expect(hasEvidence(features({ jobsTrade12m: 1 }))).toBe(true);
  });

  it("is not met by a region alone, a certificate, or quotes", () => {
    expect(hasEvidence(features({ regionMatch: true, quoteAcceptanceRate12m: 1, quotesDecided12m: 5 }))).toBe(false);
    expect(hasEvidence(blank)).toBe(false);
  });

  it("leaves a contractor with no evidence out, rather than padding the list", () => {
    expect(rulesRanker.rank([candidate(1, "Nothing Known Pty", {})], context)).toEqual([]);
  });
});

describe("reasons in plain words", () => {
  const reasonsFor = (patch: Partial<FeatureVector>) => texts(rulesRanker.rank([candidate(1, "A", { jobsHere12m: 1, ...patch })], context)[0].reasons);

  it("says what is assigned and covered, in the building's region", () => {
    const reasons = reasonsFor({ assignedToBuilding: true, regionMatch: true, tradeCovered: true });
    expect(reasons).toContain("Assigned to this building for Electrical");
    expect(reasons).toContain("Covers Electrical in Darwin");
  });

  it("splits trade and region when only one is confirmed", () => {
    expect(reasonsFor({ tradeCovered: true })).toContain("Covers Electrical");
    expect(reasonsFor({ regionMatch: true })).toContain("Services Darwin");
  });

  it("counts jobs here and in the trade, singular and plural", () => {
    expect(reasonsFor({ jobsHere12m: 3, jobsTrade12m: 2 })).toEqual(expect.arrayContaining(["3 jobs here in the last 12 months", "2 Electrical jobs in the last 12 months"]));
    expect(reasonsFor({ jobsHere12m: 1, jobsTrade12m: 1 })).toEqual(expect.arrayContaining(["1 job here in the last 12 months", "1 Electrical job in the last 12 months"]));
  });

  it("reports quote acceptance only once enough quotes are decided", () => {
    expect(reasonsFor({ quoteAcceptanceRate12m: 1, quotesAccepted12m: 2, quotesDecided12m: 2 })).not.toContain("Quotes accepted 2 of 2 times in the last 12 months");
    expect(reasonsFor({ quoteAcceptanceRate12m: 0.8, quotesAccepted12m: 4, quotesDecided12m: 5 })).toContain("Quotes accepted 4 of 5 times in the last 12 months");
  });

  it("mentions how fast they finish only when it earned points", () => {
    expect(reasonsFor({ medianDaysToComplete12m: 6.4 })).toContain("Usually finishes jobs in 6 days");
    expect(reasonsFor({ medianDaysToComplete12m: 0.2 })).toContain("Usually finishes jobs in 1 day");
    expect(reasonsFor({ medianDaysToComplete12m: 30 }).some((text) => text.startsWith("Usually finishes"))).toBe(false);
  });

  it.each([
    [{ certificateDaysToExpiry: 12, certificateStatus: "expiring" as const }, "Certificate of currency expires in 12 days"],
    [{ certificateDaysToExpiry: 1, certificateStatus: "expiring" as const }, "Certificate of currency expires in 1 day"],
    [{ certificateDaysToExpiry: 0, certificateStatus: "expiring" as const }, "Certificate of currency expires today"],
    [{ certificateDaysToExpiry: -8, certificateStatus: "expired" as const }, "Certificate of currency expired 8 days ago"],
    [{ certificateDaysToExpiry: 0, certificateStatus: "expired" as const }, "Certificate of currency expired today"],
    [{ certificateDaysToExpiry: null, certificateStatus: "missing" as const }, "No certificate of currency recorded"],
    [{ certificateDaysToExpiry: null, certificateStatus: "unknown" as const }, "Certificate of currency has no expiry date recorded"],
    [{ certificateDaysToExpiry: 214, certificateStatus: "valid" as const }, "Certificate of currency is current, expires in 214 days"],
  ])("says the certificate's state: %j", (patch, sentence) => {
    expect(reasonsFor(patch)).toContain(sentence);
  });
});

describe("certificates lower the score and show, but never hide or block", () => {
  const base = { assignedToBuilding: true, jobsHere12m: 2 };
  const score = (patch: Partial<FeatureVector>) => rulesRanker.rank([candidate(1, "A", { ...base, ...patch })], context)[0];

  it("keeps a contractor with an expired or missing certificate on the list, below the same contractor with a valid one", () => {
    const valid = score({});
    const expired = score({ certificateDaysToExpiry: -3, certificateStatus: "expired" });
    const missing = score({ certificateDaysToExpiry: null, certificateStatus: "missing" });
    expect(expired).toBeDefined();
    expect(missing).toBeDefined();
    expect(valid.score - expired.score).toBe(RULES_V1_WEIGHTS.certificate.valid - RULES_V1_WEIGHTS.certificate.expired);
    expect(valid.score - missing.score).toBe(RULES_V1_WEIGHTS.certificate.valid - RULES_V1_WEIGHTS.certificate.missing);
  });

  it("marks the certificate line as a caution when it is bad and not when it is fine", () => {
    const certificateLine = (patch: Partial<FeatureVector>) => score(patch).reasons.find((reason) => /certificate/i.test(reason.text));
    expect(certificateLine({ certificateStatus: "expired", certificateDaysToExpiry: -1 })?.caution).toBe(true);
    expect(certificateLine({ certificateStatus: "missing", certificateDaysToExpiry: null })?.caution).toBe(true);
    expect(certificateLine({ certificateStatus: "expiring", certificateDaysToExpiry: 5 })?.caution).toBe(true);
    expect(certificateLine({})?.caution).toBe(false);
  });

  it("shows a bad certificate even when there are more positive reasons than fit", () => {
    const crowded = score({
      assignedToBuilding: true,
      certificateDaysToExpiry: -3,
      certificateStatus: "expired",
      jobsHere12m: 5,
      jobsTrade12m: 5,
      medianDaysToComplete12m: 3,
      quoteAcceptanceRate12m: 1,
      quotesAccepted12m: 5,
      quotesDecided12m: 5,
      regionMatch: true,
      tradeCovered: true,
    });
    expect(crowded.reasons.filter((reason) => !reason.caution)).toHaveLength(MAX_POSITIVE_REASONS);
    expect(crowded.reasons.some((reason) => reason.caution && /expired/.test(reason.text))).toBe(true);
  });
});

describe("recorded mismatches count against a contractor and say so", () => {
  it("penalises a recorded trade or region mismatch and names it as a caution", () => {
    const [ranked] = rulesRanker.rank([candidate(1, "A", { jobsHere12m: 1, regionMatch: false, tradeCovered: false })], context);
    expect(ranked.reasons.filter((reason) => reason.caution).map((reason) => reason.text)).toEqual(
      expect.arrayContaining(["Electrical is not one of their recorded trades", "Not recorded as servicing Darwin"]),
    );
    const clean = rulesRanker.rank([candidate(1, "A", { jobsHere12m: 1 })], context)[0];
    expect(clean.score - ranked.score).toBe(-RULES_V1_WEIGHTS.tradeNotCovered - RULES_V1_WEIGHTS.regionMismatch);
  });

  it("does not hold an unrecorded trade or region against anyone", () => {
    const unknown = rulesRanker.rank([candidate(1, "A", { jobsHere12m: 1, regionMatch: null, tradeCovered: null })], context)[0];
    expect(unknown.reasons.every((reason) => !reason.caution)).toBe(true);
  });
});

describe("the arithmetic", () => {
  it("adds the documented points", () => {
    const f = features({
      assignedToBuilding: true,
      certificateDaysToExpiry: 100,
      certificateStatus: "valid",
      jobsHere12m: 3,
      jobsTrade12m: 2,
      medianDaysToComplete12m: 10,
      quoteAcceptanceRate12m: 0.8,
      quotesAccepted12m: 4,
      quotesDecided12m: 5,
      regionMatch: true,
      tradeCovered: true,
    });
    const total = componentsFor(f, context).reduce((sum, component) => sum + component.points, 0);
    // 40 assigned + (20 trade + 15 region) + 3x4 here + 2x2 trade + 0.8x10 quotes + 2 speed + 5 certificate
    expect(total).toBeCloseTo(40 + 35 + 12 + 4 + 8 + 2 + 5, 6);
    expect(rulesRanker.rank([{ contractorId: 1, features: f, name: "A" }], context)[0].score).toBe(106);
  });

  it("caps history so a busy contractor cannot outweigh an assignment", () => {
    const [busy] = rulesRanker.rank([candidate(1, "Busy", { jobsHere12m: 50, jobsTrade12m: 80 })], context);
    const [assigned] = rulesRanker.rank([candidate(2, "Assigned", { assignedToBuilding: true })], context);
    expect(assigned.score).toBeGreaterThan(busy.score);
    expect(busy.score).toBe(RULES_V1_WEIGHTS.maxJobsHere * RULES_V1_WEIGHTS.perJobHere + RULES_V1_WEIGHTS.maxJobsTrade * RULES_V1_WEIGHTS.perJobTrade + RULES_V1_WEIGHTS.certificate.valid);
  });
});

describe("ordering", () => {
  it("puts the higher score first and breaks ties by jobs here, then name, then id", () => {
    const ranked = rulesRanker.rank(
      [
        candidate(3, "Beta", { tradeCovered: true }),
        candidate(1, "Alpha", { tradeCovered: true }),
        candidate(2, "Alpha", { tradeCovered: true }),
        candidate(4, "Gamma", { tradeCovered: true, jobsHere12m: 1 }),
        candidate(5, "Zed", { assignedToBuilding: true }),
      ],
      context,
    );
    expect(ranked.map((item) => item.contractorId)).toEqual([5, 4, 1, 2, 3]);
  });

  it("returns the same order whatever order the candidates arrive in", () => {
    const list = [candidate(1, "A", { jobsHere12m: 2 }), candidate(2, "B", { assignedToBuilding: true }), candidate(3, "C", { tradeCovered: true })];
    const forward = rulesRanker.rank(list, context).map((item) => item.contractorId);
    const reversed = rulesRanker.rank([...list].reverse(), context).map((item) => item.contractorId);
    expect(reversed).toEqual(forward);
  });
});

describe("an unknown trade (a job whose category is not a trade)", () => {
  const noTrade: SuggestionContext = { ...context, trade: null };

  it("suggests only on history and never mentions a trade", () => {
    const ranked = rulesRanker.rank(
      [candidate(1, "Local", { jobsHere12m: 2 }), candidate(2, "Covers", { assignedToBuilding: true, tradeCovered: true })],
      noTrade,
    );
    expect(ranked.map((item) => item.contractorId)).toEqual([1, 2]);
    expect(texts(ranked[0].reasons)).toContain("2 jobs here in the last 12 months");
    expect(texts(ranked[0].reasons).join(" ")).not.toMatch(/Electrical/);
  });
});

describe("from raw inputs, end to end", () => {
  it("ranks an assigned, quoting, recently active contractor above a covered stranger", () => {
    const base: Omit<FeatureInputs, "assignedToBuilding" | "engagements" | "profile" | "quoteStatuses"> = {
      buildingId: 10,
      buildingRegion: "Darwin",
      certificates: [{ buildingId: null, expiresOn: "2027-06-30", insuranceType: "Public liability", issuedOn: null }],
      since: new Date("2025-10-22T14:30:00Z"),
      today: "2026-10-23",
      trade: "Electrical",
    };
    const regular = buildFeatureVector({
      ...base,
      assignedToBuilding: true,
      engagements: [{ buildingId: 10, category: "Electrical", createdAt: new Date("2026-09-01T00:00:00Z"), doneAt: null, jobId: 1 }],
      profile: { regions: ["Darwin"], trades: ["Electrical"] },
      quoteStatuses: ["approved"],
    });
    const stranger = buildFeatureVector({ ...base, assignedToBuilding: false, engagements: [], profile: { regions: ["Darwin"], trades: ["Electrical"] }, quoteStatuses: [] });
    const ranked = rulesRanker.rank(
      [
        { contractorId: 2, features: stranger, name: "Stranger Electrical" },
        { contractorId: 1, features: regular, name: "Regular Electrical" },
      ],
      context,
    );
    expect(ranked.map((item) => item.name)).toEqual(["Regular Electrical", "Stranger Electrical"]);
  });
});
