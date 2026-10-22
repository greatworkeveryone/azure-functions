/// <reference types="jest" />
import { ancillariesByRow } from "../rentReview/cascade";
import { chargedOn, computeCharges, parseReliefs } from "../scheduleCharges";
import type { PendingChangeItem } from "../scheduleChange/pending";
import { computeScheduleRows, parseGroups, parseMiscFees, parseSteps } from "../scheduledRateStepLogic";
import { scheduleTermsOf } from "../scheduleTerms";
import { buildTenancySchedule, isVacantSpace, type TenancyScheduleData, wholeMonthsBetween } from "./build";
import type { TenancyScheduleLease, TenancyScheduleResponse } from "./types";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GENERATED = "2026-10-22T01:00:00.000Z";
const ASOF = "2026-11-01";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const commencement = (from: string, rent: number, sqm: number, ahac?: number) => ({
  baseRentPerAnnum: rent,
  effectiveFrom: from,
  id: id(Number(from.replace(/-/g, "").slice(2))),
  methodKind: "commencement",
  ratePercent: 0,
  sqm,
  ...(ahac ? { ahacBasePerAnnum: ahac } : {}),
});
const review = (from: string, methodKind: string, ratePercent: number, extra: Record<string, unknown> = {}) => ({
  effectiveFrom: from,
  id: id(Number(from.replace(/-/g, "").slice(2)) + 7),
  methodKind,
  ratePercent,
  ...extra,
});

const FEE_STORAGE = {
  baseAmount: 500,
  commencedAt: "2024-07-01",
  frequency: "monthly",
  id: id(901),
  rateSteps: [{ effectiveFrom: "2028-07-01", id: id(951), methodKind: "fixed", ratePercent: 5 }],
  title: "Storage cage",
};
const FEE_SIGN = { baseAmount: 1000, commencedAt: "2024-07-01", endsAt: "2026-06-30", frequency: "annual", id: id(902), title: "Sign fee" };
const GROUP_BASEMENT = { baseMonthlyRate: 300, carparkIds: ["a", "b", "c"], commencedAt: "2024-07-01", id: id(801), label: "Basement bays" };
const RELIEF = { from: "2026-09-01", id: "relief-1", kind: "percent", scope: ["rent"], to: "2026-12-31", value: 10 };

const json = (value: unknown): string => JSON.stringify(value);

function tenant(over: Record<string, unknown>): Record<string, unknown> {
  return {
    BuildingId: 1,
    CarparkScheduleGroups: null,
    Commencement: "2024-07-01",
    Expiry: "2030-06-30",
    IdNo: null,
    InfoSheetSections: null,
    LegalName: "Tenant",
    MiscFees: null,
    OptionPeriods: null,
    PrimaryContactEmail: null,
    PrimaryContactName: null,
    PrimaryContactPhone: null,
    RentPerAnnum: 0,
    RentReliefs: null,
    ScheduledRateSteps: null,
    ScheduleSignedOffAt: null,
    Status: "current",
    TermMonths: null,
    TradingName: null,
    ...over,
  };
}
const occ = (tenantId: number, level: string, area: string, sizeSqm: number) => ({ Area: area, BuildingId: 1, Level: level, OccupancyId: `o${tenantId}${area}`, SizeSqm: sizeSqm, TenantId: tenantId });
const signed = { ScheduleSignedOffAt: new Date("2026-01-01T00:00:00Z"), ScheduleSignedOffByName: "Cfo" };

// Rows carry the exclusive end the schedule editor writes (closeOpenPredecessor), which decides where a fee's or group's own step applies.
const STEPS_A = [
  { ...commencement("2024-07-01", 120000, 200, 6000), effectiveTo: "2025-07-01" },
  { ...review("2025-07-01", "fixed", 4), effectiveTo: "2027-07-01" },
  { ...review("2027-07-01", "cpi", 0), effectiveTo: "2028-07-01" },
  review("2028-07-01", "fixed", 3),
];

const A = tenant({
  CarparkScheduleGroups: json([GROUP_BASEMENT]),
  CpiRegion: "DARWIN",
  IdNo: "L-001",
  InfoSheetSections: json([
    { displayOrder: 2, id: "s2", rows: [{ body: " Two years ", displayOrder: 1, id: "r1", subheader: "Make good" }], title: "Fit-out" },
    { displayOrder: 1, id: "s1", rows: [{ body: "Yes", displayOrder: 1, id: "r2", subheader: "Sublease" }, { body: "", displayOrder: 2, id: "r3", subheader: "" }], title: "Assignment" },
    { displayOrder: 3, id: "s3", rows: [{ body: "gone", displayOrder: 1, id: "r4", subheader: "x" }], strikethrough: true, title: "Struck" },
  ]),
  LegalName: "Acme Pty Ltd",
  MiscFees: json([FEE_STORAGE, FEE_SIGN]),
  OptionPeriods: "2 x 3 years",
  PrimaryContactEmail: "pat@acme.example",
  PrimaryContactName: "Pat",
  PrimaryContactPhone: "0400 000 000",
  RentPerAnnum: 120000,
  RentReliefs: json([RELIEF]),
  ScheduledRateSteps: json(STEPS_A),
  TenantId: 11,
  TradingName: "Acme Coffee",
  ...signed,
});
const B = tenant({
  Expiry: "2026-01-31",
  LegalName: "Bright Ltd",
  MiscFees: json([{ baseAmount: 2400, commencedAt: "2020-01-01", frequency: "annual", id: id(903), title: " storage CAGE " }]),
  RentPerAnnum: 50000,
  ScheduledRateSteps: json([commencement("2020-01-01", 50000, 100)]),
  TenantId: 12,
  TermMonths: 24,
  Commencement: "2020-01-01",
});
const C = tenant({ LegalName: " vacant ", TenantId: 13 });
const D = tenant({ LegalName: "Old Tenant", Status: "vacated", TenantId: 14 });
const E = tenant({ Commencement: "2027-01-01", Expiry: null, LegalName: "Evolve Ltd", RentPerAnnum: 40000, Status: "pending", TenantId: 15 });
const F = tenant({
  BuildingId: 2,
  LegalName: "Fresh Co",
  RentPerAnnum: 60000,
  ScheduledRateSteps: json([commencement("2025-01-01", 60000, 60)]),
  TenantId: 21,
  ...signed,
  PrimaryContactName: "Fran",
});
const G = tenant({ BuildingId: 2, LegalName: "No Units Pty", RentPerAnnum: 12000, TenantId: 22, ...signed, PrimaryContactEmail: "g@example.com" });

const pendingReview: PendingChangeItem = { buildingId: 1, from: "2027-07-01", kind: "rent_review", requestId: "rev-1", summary: "Rent review", tenantId: 11, tenantName: "Acme Coffee", to: null };
const pendingRelief: PendingChangeItem = { buildingId: 1, from: "2026-12-01", kind: "relief", requestId: "rel-9", summary: "Relief", tenantId: 12, tenantName: "Bright Ltd", to: "2027-01-31" };

const carpark = (n: number, kind: string, tenantId: number | null, buildingId = 1) => ({ AllocationKind: kind, BuildingId: buildingId, CarparkId: `cp${n}`, TenantId: tenantId });

function data(over: Partial<TenancyScheduleData> = {}): TenancyScheduleData {
  return {
    buildings: [
      { BuildingAddress: "1 Zeta St, Darwin", BuildingID: 1, BuildingName: "Zeta House", ReferenceCode: "ZH" },
      { BuildingAddress: null, BuildingID: 2, BuildingName: "Alpha Plaza", ReferenceCode: null },
    ],
    carparks: [
      carpark(1, "tenant", 11), carpark(2, "tenant", 11), carpark(3, "tenant", 11), carpark(4, "tenant", 12), carpark(5, "tenant", 13), carpark(6, "vacant", null), carpark(7, "randazzo", null),
    ],
    occupancies: [
      occ(11, "Ground", "G1", 200),
      occ(12, "Level 2", "Suite 2.01", 100),
      occ(13, "Level 1", "Suite 1.01", 150),
      occ(14, "Level 1", "Suite 1.02", 50),
      occ(15, "Level 3", "Suite 3.01", 100),
      { ...occ(21, "Level 1", "Shop 1", 60), BuildingId: 2 },
    ],
    pending: [pendingReview, pendingRelief],
    tenants: [A, B, C, D, E, F, G] as TenancyScheduleData["tenants"],
    ...over,
  };
}

const build = (asOf = ASOF, d: TenancyScheduleData = data()): TenancyScheduleResponse => buildTenancySchedule({ asOf, data: d, generatedAt: GENERATED });
const lease = (r: TenancyScheduleResponse, tenantId: number): TenancyScheduleLease => {
  const found = r.buildings.flatMap((b) => b.leases).find((l) => l.tenantId === tenantId);
  if (!found) throw new Error(`no lease ${tenantId}`);
  return found;
};
const zeta = (r: TenancyScheduleResponse) => r.buildings.find((b) => b.buildingId === 1)!;

/** What the register's engine path charges the tenancy on `asOf`, summed, straight from the engine. */
function engineTotal(row: Record<string, unknown>, nla: number, asOf: string): { charged: number; lease: number } {
  const rent = Number(row.RentPerAnnum);
  const rows = computeScheduleRows(parseSteps(row.ScheduledRateSteps as string), rent, nla, scheduleTermsOf(row));
  const schedule = computeCharges(rows, {
    ancillaries: ancillariesByRow(rows, parseGroups(row.CarparkScheduleGroups as string), parseMiscFees(row.MiscFees as string)),
    fallbackAnnual: rent,
    reliefs: parseReliefs(row.RentReliefs as string),
  });
  const period = chargedOn(schedule, asOf);
  const add = (c: { ahac: number | null; carparks: number | null; miscFees: number | null; rent: number | null } | undefined) =>
    Math.round(((c?.rent ?? 0) + (c?.ahac ?? 0) + (c?.carparks ?? 0) + (c?.miscFees ?? 0)) * 100) / 100;
  return { charged: add(period?.charged), lease: add(period?.lease) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("charges reconcile with the engine's chargedOn", () => {
  const dates = ["2024-06-01", "2024-07-01", "2025-06-30", "2025-07-01", "2025-12-01", "2026-06-30", "2026-07-01", "2026-09-01", ASOF, "2026-12-31", "2027-01-01", "2027-07-01", "2028-07-01", "2029-01-01"];

  it.each(dates)("lease total equals the sum of chargedOn(...).charged on %s, to the cent", (asOf) => {
    const built = lease(build(asOf), 11);
    const expected = engineTotal(A, 200, asOf);
    expect(built.total.annual).toBe(expected.charged);
    const lines = built.charges.filter((c) => c.kind !== "relief");
    expect(Math.round(lines.reduce((t, c) => t + c.annual, 0) * 100) / 100).toBe(expected.lease);
    expect(Math.round(built.charges.reduce((t, c) => t + c.annual, 0) * 100) / 100).toBe(built.total.annual);
  });

  it("splits the figures on a day with a ratified relief, a car park group and a fee", () => {
    const l = lease(build(ASOF), 11);
    expect(l.charges.map((c) => [c.kind, c.label, c.annual])).toEqual([
      ["rent", "Rent", 124800],
      ["ahac", "After-hours A/C", 6240],
      ["miscFee", "Storage cage", 6240],
      ["carparkGroup", "Basement bays", 3744],
      ["relief", "Rent relief", -12480],
    ]);
    expect(l.total).toEqual({ annual: 128544, monthly: 10712, perSqm: 642.72 });
    expect(l.charges[3].bays).toBe(3);
    expect(l.charges[0]).toMatchObject({ bays: null, effectiveFrom: "2025-07-01", monthly: 10400, perSqm: 624 });
    expect(l.charges[4].effectiveFrom).toBe("2026-09-01");
  });

  it("leaves out a misc fee that ended before the date, and shows it while it ran", () => {
    expect(lease(build(ASOF), 11).charges.map((c) => c.label)).not.toContain("Sign fee");
    const earlier = lease(build("2025-12-01"), 11);
    expect(earlier.charges.find((c) => c.label === "Sign fee")?.annual).toBe(1040);
    expect(lease(build("2026-06-30"), 11).charges.map((c) => c.label)).toContain("Sign fee");
  });

  it("charges nothing, with a zero rent line, before the schedule starts", () => {
    const l = lease(build("2024-06-01"), 11);
    expect(l.charges).toEqual([expect.objectContaining({ annual: 0, effectiveFrom: "2024-07-01", kind: "rent", label: "Rent" })]);
    expect(l.total.annual).toBe(0);
  });

  it("picks up a scheduled increase on a future date", () => {
    const before = lease(build("2025-06-30"), 11);
    const after = lease(build("2025-07-01"), 11);
    expect(before.charges[0].annual).toBe(120000);
    expect(after.charges[0].annual).toBe(124800);
    expect(after.charges[0].effectiveFrom).toBe("2025-07-01");
    expect(after.charges[1].annual).toBe(6240);
  });

  it("charges the stored base rent for a tenancy with no schedule rows, from its commencement", () => {
    const l = lease(build(), 15);
    expect(l.charges).toEqual([{ annual: 40000, bays: null, effectiveFrom: "2027-01-01", kind: "rent", label: "Rent", monthly: 3333.33, perSqm: 400 }]);
    expect(l.status).toBe("pending");
  });

  it("uses a fee's and a group's own step on the row in force, and still reconciles", () => {
    const row = tenant({
      ...A,
      CarparkScheduleGroups: json([{ ...GROUP_BASEMENT, rateSteps: [{ effectiveFrom: "2025-07-01", id: id(953), newMonthlyRate: 400 }] }]),
      MiscFees: json([{ ...FEE_STORAGE, rateSteps: [{ effectiveFrom: "2025-07-01", id: id(954), newAmount: 600 }] }]),
    });
    const r = build(ASOF, data({ tenants: [row] as TenancyScheduleData["tenants"] }));
    const l = lease(r, 11);
    expect(l.charges.find((c) => c.kind === "miscFee")?.annual).toBe(7200);
    expect(l.charges.find((c) => c.kind === "carparkGroup")?.annual).toBe(4800);
    expect(l.total.annual).toBe(engineTotal(row, 200, ASOF).charged);
  });

  it("reconciles every tenancy in the fixtures on every date", () => {
    for (const asOf of dates) {
      const r = build(asOf);
      for (const [row, nla] of [[A, 200], [B, 100], [E, 100], [F, 60], [G, 0]] as const) {
        expect(lease(r, Number(row.TenantId)).total.annual).toBe(engineTotal(row, nla, asOf).charged);
      }
    }
  });

  it("carries money to the cent and a null perSqm when NLA is 0", () => {
    const l = lease(build(), 22);
    expect(l.nlaSqm).toBe(0);
    expect(l.total).toEqual({ annual: 12000, monthly: 1000, perSqm: null });
    expect(l.charges[0].perSqm).toBeNull();
  });
});

describe("lease fields", () => {
  const l = () => lease(build(), 11);

  it("maps the register columns", () => {
    expect(l()).toMatchObject({
      commencement: "2024-07-01",
      contact: { email: "pat@acme.example", name: "Pat", phone: "0400 000 000" },
      expiry: "2030-06-30",
      leaseCode: "L-001",
      legalName: "Acme Pty Ltd",
      nlaSqm: 200,
      optionPeriods: "2 x 3 years",
      parkingBays: 3,
      scheduleSignedOff: true,
      status: "current",
      tradingName: "Acme Coffee",
      units: [{ area: "G1", level: "Ground", sizeSqm: 200 }],
    });
  });

  it("works out the term from the dates unless one is stored", () => {
    expect(l().termMonths).toBe(72);
    expect(lease(build(), 12).termMonths).toBe(24);
    expect(lease(build(), 15).termMonths).toBeNull();
  });

  it("reads a stored current lease past its expiry as holdover on the date", () => {
    expect(lease(build(), 12).status).toBe("holdover");
    expect(lease(build("2025-06-01"), 12).status).toBe("current");
  });

  it("lists info sheet sections in order, leaving out struck-through sections and blank rows", () => {
    expect(l().notes).toEqual([
      { rows: [{ body: "Yes", subheader: "Sublease" }], title: "Assignment" },
      { rows: [{ body: "Two years", subheader: "Make good" }], title: "Fit-out" },
    ]);
  });

  it("has no contact when the three fields are blank", () => {
    expect(lease(build(), 12).contact).toBeNull();
  });
});

describe("reviews", () => {
  it("lists schedule rows after the date, within the term, with method, description and what reviews", () => {
    expect(lease(build(), 11).reviews).toEqual([
      { appliesTo: ["Rent", "After-hours A/C"], date: "2027-07-01", description: "CPI Darwin", method: "cpi", pending: true },
      { appliesTo: ["Rent", "Storage cage", "After-hours A/C"], date: "2028-07-01", description: "Fixed 3%", method: "fixed", pending: false },
    ]);
  });

  it("drops reviews that have happened by the date, and those past the expiry", () => {
    expect(lease(build("2027-07-01"), 11).reviews.map((r) => r.date)).toEqual(["2028-07-01"]);
    const short = tenant({ ...A, Expiry: "2027-12-31" });
    const r = build(ASOF, data({ tenants: [short] as TenancyScheduleData["tenants"] }));
    expect(lease(r, 11).reviews.map((x) => x.date)).toEqual(["2027-07-01"]);
  });

  it("describes market and other reviews, and a fixed review with no rate", () => {
    const row = tenant({
      ...A,
      MiscFees: null,
      ScheduledRateSteps: json([commencement("2024-07-01", 100000, 100), review("2027-01-01", "market", 0), review("2028-01-01", "other", 2, { note: " Reset to turnover " }), review("2029-01-01", "fixed", 0)]),
    });
    const reviews = lease(build(ASOF, data({ tenants: [row] as TenancyScheduleData["tenants"] })), 11).reviews;
    expect(reviews.map((r) => [r.method, r.description, r.appliesTo])).toEqual([
      ["market", "Market review", ["Rent"]],
      ["other", "Reset to turnover", ["Rent"]],
      ["fixed", "Fixed review", ["Rent"]],
    ]);
  });

  it("lists a car park group with a step on the date", () => {
    const group = { ...GROUP_BASEMENT, rateSteps: [{ effectiveFrom: "2028-07-01", id: id(952), newMonthlyRate: 400 }] };
    const row = tenant({ ...A, CarparkScheduleGroups: json([group]) });
    const reviews = lease(build(ASOF, data({ tenants: [row] as TenancyScheduleData["tenants"] })), 11).reviews;
    expect(reviews[1].appliesTo).toEqual(["Rent", "Storage cage", "Basement bays", "After-hours A/C"]);
  });
});

describe("vacancies, bays and sort order", () => {
  it("treats Vacant rows and vacated tenancies' units as vacancies, not leases", () => {
    const z = zeta(build());
    expect(z.vacancies).toEqual([
      { nlaSqm: 150, tenantId: 13, units: [{ area: "Suite 1.01", level: "Level 1", sizeSqm: 150 }] },
      { nlaSqm: 50, tenantId: 14, units: [{ area: "Suite 1.02", level: "Level 1", sizeSqm: 50 }] },
    ]);
    expect(z.leases.map((x) => x.tenantId)).toEqual([11, 12, 15]);
    expect(isVacantSpace("  VACANT ")).toBe(true);
    expect(isVacantSpace("Vacant Shop Pty")).toBe(false);
  });

  it("sorts buildings by name and leases naturally by first unit, units-less leases last", () => {
    const r = build();
    expect(r.buildings.map((b) => b.name)).toEqual(["Alpha Plaza", "Zeta House"]);
    expect(r.buildings[0].leases.map((x) => x.tenantId)).toEqual([21, 22]);
    const levels = [tenant({ ...A, TenantId: 31 }), tenant({ ...A, TenantId: 32 }), tenant({ ...A, TenantId: 33 })];
    const sorted = build(
      ASOF,
      data({
        occupancies: [occ(31, "Level 10", "S1", 10), occ(32, "Level 2", "S10", 10), occ(33, "Level 2", "S2", 10)],
        tenants: levels as TenancyScheduleData["tenants"],
      }),
    );
    expect(sorted.buildings.find((b) => b.buildingId === 1)!.leases.map((x) => x.tenantId)).toEqual([33, 32, 31]);
  });

  it("counts bays leased, vacant and other, and the lease's own bays", () => {
    const z = zeta(build());
    expect(z.summary.bays).toEqual({ leased: 4, other: 1, total: 7, vacant: 2 });
    expect(lease(build(), 12).parkingBays).toBe(1);
    expect(lease(build(), 15).parkingBays).toBe(0);
  });

  it("computes NLA, vacant NLA and the vacant percent with getPortfolioOccupancy's rule", () => {
    const { summary } = zeta(build());
    // 200 + 100 + 150 + 50 + 100 = 600; current + holdover = 300; the pending lease's 100 counts as vacant.
    expect(summary).toMatchObject({ leaseCount: 3, totalNlaSqm: 600, vacantNlaSqm: 300, vacantPercent: 50 });
    expect(build().buildings[0].summary).toMatchObject({ totalNlaSqm: 60, vacantNlaSqm: 0, vacantPercent: 0 });
  });
});

describe("summary", () => {
  it("groups by kind, with fees by trimmed case-insensitive title and perSqm over total NLA", () => {
    const { byLabel, total } = zeta(build()).summary;
    expect(byLabel.map((x) => [x.kind, x.label, x.annual])).toEqual([
      ["rent", "Rent", 124800 + 50000 + 40000],
      ["ahac", "After-hours A/C", 6240],
      ["miscFee", "Storage cage", 6240 + 2400],
      ["carparkGroup", "Car parks", 3744],
      ["relief", "Rent relief", -12480],
    ]);
    expect(byLabel[0]).toMatchObject({ monthly: 17900, perSqm: 358 });
    expect(total.annual).toBe(124800 + 50000 + 40000 + 6240 + 8640 + 3744 - 12480);
    expect(total.perSqm).toBe(Math.round((total.annual / 600) * 100) / 100);
  });

  it("adds the buildings up for the portfolio", () => {
    const r = build();
    const sum = (pick: (b: (typeof r.buildings)[number]) => number): number => Math.round(r.buildings.reduce((t, b) => t + pick(b), 0) * 100) / 100;
    expect(r.portfolio.totalNlaSqm).toBe(sum((b) => b.summary.totalNlaSqm));
    expect(r.portfolio.vacantNlaSqm).toBe(sum((b) => b.summary.vacantNlaSqm));
    expect(r.portfolio.total.annual).toBe(sum((b) => b.summary.total.annual));
    expect(r.portfolio.leaseCount).toBe(5);
    expect(r.portfolio.bays).toEqual({ leased: 4, other: 1, total: 7, vacant: 2 });
    expect(r.portfolio.vacantPercent).toBe(Math.round((300 / 660) * 10000) / 100);
    const rent = r.portfolio.byLabel.find((x) => x.kind === "rent")!;
    expect(rent.annual).toBe(sum((b) => b.summary.byLabel.find((x) => x.kind === "rent")?.annual ?? 0));
    expect(rent.perSqm).toBe(Math.round((rent.annual / 660) * 100) / 100);
  });

  it("is zero, not NaN, for a building with no NLA", () => {
    const r = build(ASOF, data({ occupancies: [], tenants: [G] as TenancyScheduleData["tenants"] }));
    expect(r.buildings.find((b) => b.buildingId === 2)!.summary).toMatchObject({ totalNlaSqm: 0, vacantNlaSqm: 0, vacantPercent: 0 });
    expect(r.portfolio.total.perSqm).toBeNull();
  });
});

describe("gaps and pending changes", () => {
  it("lists tenancies missing an expiry, an occupancy, a contact or a sign-off", () => {
    const r = build();
    expect(zeta(r).gaps).toEqual([
      { kinds: ["noContact", "scheduleNotSignedOff"], name: "Bright Ltd", tenantId: 12 },
      { kinds: ["noExpiry", "noContact", "scheduleNotSignedOff"], name: "Evolve Ltd", tenantId: 15 },
    ]);
    expect(r.buildings[0].gaps).toEqual([{ kinds: ["noOccupancy"], name: "No Units Pty", tenantId: 22 }]);
  });

  it("carries each tenancy's pending changes and the counts", () => {
    const r = build();
    expect(lease(r, 11).pendingChanges).toEqual([pendingReview]);
    expect(lease(r, 12).pendingChanges).toEqual([pendingRelief]);
    expect(lease(r, 15).pendingChanges).toEqual([]);
    expect(zeta(r).pendingChangeCount).toBe(2);
    expect(r.buildings[0].pendingChangeCount).toBe(0);
    expect(r.pendingChanges).toEqual({ count: 2, items: [pendingReview, pendingRelief] });
  });

  it("echoes the dates and the building header", () => {
    const r = build();
    expect(r.asOf).toBe(ASOF);
    expect(r.generatedAt).toBe(GENERATED);
    expect(zeta(r)).toMatchObject({ address: "1 Zeta St, Darwin", buildingId: 1, name: "Zeta House", referenceCode: "ZH" });
    expect(r.buildings[0]).toMatchObject({ address: null, referenceCode: null });
  });
});

describe("wholeMonthsBetween", () => {
  it.each([
    ["2024-07-01", "2030-06-30", 72],
    ["2024-07-15", "2025-07-14", 12],
    ["2024-07-01", "2025-01-15", 6],
    ["2024-07-01", "2024-07-01", 0],
    ["2025-01-01", "2024-01-01", null],
    [null, "2024-01-01", null],
  ])("%s to %s is %s months", (from, to, expected) => {
    expect(wholeMonthsBetween(from, to)).toBe(expected);
  });
});
