/// <reference types="jest" />
import { buildComplianceReport, type ComplianceData } from "./build";
import type { ComplianceBuilding, ComplianceScope } from "./types";

// The Compliance rules, on fixtures: each of the four sections at its edges, commercial
// buildings only, only what a manager set up (no assumed required trades), and the counts
// that follow from them. The certificate rule itself is pinned by the shared vectors
// (insuranceEvidence.test.ts); here it is shown at the report's boundaries and scopes.

const ASOF = "2026-10-23";
const ALL: ComplianceScope = { all: true };
const BUILDINGS = [
  { BuildingID: 7, BuildingName: "Bravo Tower", ReferenceCode: "BR" },
  { BuildingID: 3, BuildingName: "Alpha House", ReferenceCode: "AL" },
];

let nextId = 1;
const schedule = (over: Record<string, unknown> = {}) => ({
  Active: true,
  AnchorDate: "2026-01-01",
  ArchivedAt: null,
  AssetId: null,
  AssetName: null,
  AssetTag: null,
  BuildingId: 3,
  Category: "HVAC / mechanical",
  ContractorId: null,
  ContractorName: null,
  IntervalCount: 3,
  IntervalUnit: "months",
  IsContract: false,
  LeadDays: 14,
  Name: "Quarterly service",
  NextDue: "2026-12-01",
  Scope: "All units",
  ServiceScheduleId: nextId++,
  ...over,
});
const period = (over: Record<string, unknown> = {}) => ({
  ArchivedAt: null,
  BuildingId: 3,
  ContractorId: null,
  ContractorName: null,
  DefectsPeriodId: nextId++,
  EndsOn: "2027-06-30",
  Enforcement: "block",
  LevelName: null,
  LocationId: null,
  PracticalCompletion: "2026-06-30",
  Scope: "building",
  Services: "all",
  TenantId: null,
  TenantName: null,
  Works: "Level 2 fit-out",
  ...over,
});
const contractor = (id: number, name: string, over: Record<string, unknown> = {}) => ({ Active: true, ContractorID: id, ContractorName: name, Suspended: false, ...over });
const certificate = (over: Record<string, unknown> = {}) => ({
  BuildingId: null,
  ContractorId: 10,
  DocumentId: nextId++,
  ExpiresOn: new Date("2027-04-30T00:00:00Z"),
  InsuranceType: "Public liability",
  IssuedOn: new Date("2026-05-01T00:00:00Z"),
  Kind: "certificate",
  ServiceCategory: "Insurance",
  ...over,
});
const plan = (buildingId: number, trades: unknown) => ({ BuildingId: buildingId, PlanJson: JSON.stringify(trades) });

const run = (data: Partial<ComplianceData>, scope: ComplianceScope = ALL, asOf = ASOF) =>
  buildComplianceReport({
    asOf,
    data: { buildings: BUILDINGS, certificates: [], contractors: [], periods: [], plans: [], schedules: [], ...data },
    generatedAt: "2026-10-23T05:00:00.000Z",
    scope,
  });
const building = (report: ReturnType<typeof run>, id: number): ComplianceBuilding | undefined => report.buildings.find((candidate) => candidate.buildingId === id);

describe("certificates of currency", () => {
  const onSchedule = (id = 10) => schedule({ ContractorId: id });

  it("flags a contractor on a live schedule who has no certificate at all, as missing", () => {
    const report = run({ contractors: [contractor(10, "Cool Air")], schedules: [onSchedule()] });
    expect(building(report, 3)?.certificates).toEqual([
      { contractorId: 10, expiresOn: null, insuranceType: "Certificate of currency", name: "Cool Air", standing: "active", startsOn: null, state: "missing" },
    ]);
  });

  it("checks a contractor named only in the building's coverage, whether or not the trade is required", () => {
    const report = run({ contractors: [contractor(10, "Cool Air")], plans: [plan(3, [{ contractorIds: [10], required: false, trade: "HVAC / mechanical" }])] });
    expect(building(report, 3)?.certificates.map((finding) => finding.contractorId)).toEqual([10]);
  });

  it("does not check a contractor whose only schedule is paused or archived", () => {
    const report = run({ contractors: [contractor(10, "Cool Air")], schedules: [schedule({ Active: false, ContractorId: 10 }), schedule({ ArchivedAt: new Date("2026-09-01T00:00:00Z"), ContractorId: 10 })] });
    expect(report.buildings).toEqual([]);
    expect(report.checked).toMatchObject({ contractors: 0, schedules: 0 });
  });

  it.each([
    ["the day before", "2026-10-22", "expired"],
    ["the date itself", "2026-10-23", "expiring"],
    ["30 days after", "2026-11-22", "expiring"],
    ["31 days after", "2026-11-23", null],
  ])("a certificate that expires %s (%s) is %s", (_name, expiresOn, state) => {
    const report = run({ certificates: [certificate({ ExpiresOn: new Date(`${expiresOn}T00:00:00Z`) })], contractors: [contractor(10, "Cool Air")], schedules: [onSchedule()] });
    expect(building(report, 3)?.certificates.map((finding) => finding.state) ?? []).toEqual(state === null ? [] : [state]);
    expect(report.totals.certificates).toBe(state === null ? 0 : 1);
  });

  it("reads the same dates when they arrive as text, and carries the expiry it checked", () => {
    const report = run({ certificates: [certificate({ ExpiresOn: "2026-10-01", IssuedOn: "2026-01-01" })], contractors: [contractor(10, "Cool Air")], schedules: [onSchedule()] });
    expect(building(report, 3)?.certificates).toEqual([expect.objectContaining({ expiresOn: "2026-10-01", insuranceType: "Public liability", state: "expired" })]);
  });

  it("says when a certificate starts when it only starts after the date", () => {
    const report = run({ certificates: [certificate({ IssuedOn: new Date("2026-11-01T00:00:00Z") })], contractors: [contractor(10, "Cool Air")], schedules: [onSchedule()] });
    expect(building(report, 3)?.certificates).toEqual([expect.objectContaining({ expiresOn: "2027-04-30", startsOn: "2026-11-01", state: "missing" })]);
  });

  it("flags an undated certificate, since a blank expiry is never read as cover with no end", () => {
    const report = run({ certificates: [certificate({ ExpiresOn: null })], contractors: [contractor(10, "Cool Air")], schedules: [onSchedule()] });
    expect(building(report, 3)?.certificates).toEqual([expect.objectContaining({ expiresOn: null, state: "undated" })]);
  });

  it("lets a renewal replace the older policy of the same kind, and judges each kind alone", () => {
    const certificates = [
      certificate({ ExpiresOn: new Date("2026-09-01T00:00:00Z") }),
      certificate({ ExpiresOn: new Date("2027-09-01T00:00:00Z") }),
      certificate({ ExpiresOn: new Date("2026-10-01T00:00:00Z"), InsuranceType: "Workers compensation" }),
    ];
    const report = run({ certificates, contractors: [contractor(10, "Cool Air")], schedules: [onSchedule()] });
    expect(building(report, 3)?.certificates.map((finding) => [finding.insuranceType, finding.state])).toEqual([["Workers compensation", "expired"]]);
  });

  describe("building-specific and portfolio-wide certificates", () => {
    const both = { contractors: [contractor(10, "Cool Air")], schedules: [schedule({ BuildingId: 3, ContractorId: 10 }), schedule({ BuildingId: 7, ContractorId: 10 })] };

    it("counts a certificate kept for one building for that building only", () => {
      const report = run({ ...both, certificates: [certificate({ BuildingId: 3 })] });
      expect(building(report, 3)).toBeUndefined();
      expect(building(report, 7)?.certificates).toEqual([expect.objectContaining({ contractorId: 10, state: "missing" })]);
    });

    it("counts a portfolio-wide certificate for every building", () => {
      expect(run({ ...both, certificates: [certificate({ BuildingId: null })] }).buildings).toEqual([]);
    });

    it("checks the contractor once for each building they are on", () => {
      expect(run({ ...both, certificates: [certificate({ BuildingId: null })] }).checked.contractors).toBe(2);
    });
  });

  it("counts a contractor on both a schedule and the coverage once for the building", () => {
    const report = run({
      contractors: [contractor(10, "Cool Air")],
      plans: [plan(3, [{ contractorIds: [10], required: true, trade: "HVAC / mechanical" }])],
      schedules: [onSchedule(), onSchedule()],
    });
    expect(report.checked.contractors).toBe(1);
    expect(building(report, 3)?.certificates).toHaveLength(1);
  });

  it("names a contractor as they stand: suspended, inactive, or not known at all", () => {
    const report = run({
      contractors: [contractor(10, "Cool Air", { Suspended: true }), contractor(11, "Dry Co", { Active: false })],
      schedules: [onSchedule(10), onSchedule(11), onSchedule(12)],
    });
    expect(building(report, 3)?.certificates.map((finding) => [finding.name, finding.standing])).toEqual([
      ["Contractor #12", "inactive"],
      ["Cool Air", "suspended"],
      ["Dry Co", "inactive"],
    ]);
  });

  it("lists findings by contractor name, then kind of insurance", () => {
    const certificates = [
      certificate({ ContractorId: 11, ExpiresOn: new Date("2026-10-01T00:00:00Z"), InsuranceType: "Workers compensation" }),
      certificate({ ContractorId: 11, ExpiresOn: new Date("2026-10-01T00:00:00Z"), InsuranceType: "Public liability" }),
    ];
    const report = run({ certificates, contractors: [contractor(10, "Zed Plumbing"), contractor(11, "Ace Electrical")], schedules: [onSchedule(10), onSchedule(11)] });
    expect(building(report, 3)?.certificates.map((finding) => [finding.name, finding.insuranceType])).toEqual([
      ["Ace Electrical", "Public liability"],
      ["Ace Electrical", "Workers compensation"],
      ["Zed Plumbing", "Certificate of currency"],
    ]);
  });
});

describe("trades a building requires", () => {
  const required = (trade: string, contractorIds: number[] = []) => ({ contractorIds, required: true, trade });

  it("flags a required trade with nobody named, and says nobody is", () => {
    const report = run({ plans: [plan(3, [required("HVAC / mechanical")])] });
    expect(building(report, 3)?.tradeGaps).toEqual([{ named: [], reason: "none_named", trade: "HVAC / mechanical" }]);
    expect(report.checked.requiredTrades).toBe(1);
  });

  it("flags a required trade whose contractors are all inactive or suspended, naming them", () => {
    const report = run({
      contractors: [contractor(10, "Cool Air", { Suspended: true }), contractor(11, "Breeze Co", { Active: false })],
      plans: [plan(3, [required("HVAC / mechanical", [10, 11])])],
    });
    expect(building(report, 3)?.tradeGaps).toEqual([
      {
        named: [
          { contractorId: 11, name: "Breeze Co", standing: "inactive" },
          { contractorId: 10, name: "Cool Air", standing: "suspended" },
        ],
        reason: "none_active",
        trade: "HVAC / mechanical",
      },
    ]);
  });

  it("is satisfied by one active contractor named for the trade, however many others are not", () => {
    const report = run({ contractors: [contractor(10, "Cool Air", { Suspended: true }), contractor(11, "Breeze Co")], plans: [plan(3, [required("HVAC / mechanical", [10, 11])])] });
    expect(building(report, 3)?.tradeGaps ?? []).toEqual([]);
  });

  it("is satisfied by an active contractor on a live schedule in that trade, whatever the case of the trade", () => {
    const report = run({
      contractors: [contractor(10, "Cool Air")],
      plans: [plan(3, [required("hvac / MECHANICAL")])],
      schedules: [schedule({ Category: "HVAC / mechanical", ContractorId: 10 })],
    });
    expect(building(report, 3)?.tradeGaps ?? []).toEqual([]);
  });

  it("is not satisfied by a schedule in another trade, one with no contractor, one that is paused or archived, or one at another building", () => {
    const report = run({
      contractors: [contractor(10, "Cool Air")],
      plans: [plan(3, [required("HVAC / mechanical")])],
      schedules: [
        schedule({ Category: "Electrical", ContractorId: 10 }),
        schedule({ Category: "HVAC / mechanical", ContractorId: null }),
        schedule({ Active: false, Category: "HVAC / mechanical", ContractorId: 10 }),
        schedule({ ArchivedAt: new Date("2026-09-01T00:00:00Z"), Category: "HVAC / mechanical", ContractorId: 10 }),
        schedule({ BuildingId: 7, Category: "HVAC / mechanical", ContractorId: 10 }),
      ],
    });
    expect(building(report, 3)?.tradeGaps).toEqual([{ named: [], reason: "none_named", trade: "HVAC / mechanical" }]);
  });

  it("is not satisfied by a suspended contractor on a schedule", () => {
    const report = run({
      contractors: [contractor(10, "Cool Air", { Suspended: true })],
      plans: [plan(3, [required("HVAC / mechanical")])],
      schedules: [schedule({ Category: "HVAC / mechanical", ContractorId: 10 })],
    });
    expect(building(report, 3)?.tradeGaps).toEqual([expect.objectContaining({ reason: "none_active", trade: "HVAC / mechanical" })]);
  });

  it("never flags a trade nobody marked required: an unset requirement means nothing is expected", () => {
    const report = run({ plans: [plan(3, [{ contractorIds: [], required: false, trade: "Lifts" }, { contractorIds: [], trade: "Cleaning" }])] });
    expect(report.buildings).toEqual([]);
    expect(report.checked.requiredTrades).toBe(0);
  });

  it("assumes nothing for a building with no plan", () => {
    const report = run({ schedules: [schedule({ ContractorId: null })] });
    expect(report.totals.tradeGaps).toBe(0);
    expect(report.checked.requiredTrades).toBe(0);
  });

  it("reads a plan that isn't one as no trades, rather than failing the report", () => {
    const report = run({ plans: [{ BuildingId: 3, PlanJson: "not json" }, { BuildingId: 7, PlanJson: '{"trade":"x"}' }] });
    expect(report.buildings).toEqual([]);
  });

  it("lists the trades in the maintenance list's order, then any others", () => {
    const report = run({ plans: [plan(3, [required("Zebra care"), required("Electrical"), required("Fire & life safety")])] });
    expect(building(report, 3)?.tradeGaps.map((gap) => gap.trade)).toEqual(["Fire & life safety", "Electrical", "Zebra care"]);
  });
});

describe("overdue service schedules", () => {
  const nextDue = (value: string, over: Record<string, unknown> = {}) => schedule({ NextDue: value, ...over });
  const overdue = (report: ReturnType<typeof run>) => building(report, 3)?.overdueSchedules ?? [];

  it.each([
    ["the day before the date", "2026-10-22", 1],
    ["a week before it", "2026-10-16", 7],
    ["the date itself", "2026-10-23", null],
    ["the day after", "2026-10-24", null],
  ])("a service due %s is %s days overdue", (_name, due, days) => {
    const report = run({ schedules: [nextDue(due)] });
    expect(overdue(report).map((finding) => finding.daysOverdue)).toEqual(days === null ? [] : [days]);
    expect(report.totals.overdueSchedules).toBe(days === null ? 0 : 1);
  });

  it("checks against the report's date, so a later date shows what will be overdue by then", () => {
    expect(overdue(run({ schedules: [nextDue("2026-11-01")] }))).toEqual([]);
    expect(overdue(run({ schedules: [nextDue("2026-11-01")] }, ALL, "2026-11-02")).map((finding) => finding.daysOverdue)).toEqual([1]);
  });

  it("leaves out a paused schedule and an archived one", () => {
    const report = run({ schedules: [nextDue("2026-10-01", { Active: false }), nextDue("2026-10-01", { ArchivedAt: new Date("2026-09-01T00:00:00Z") })] });
    expect(report.buildings).toEqual([]);
  });

  it("describes the service: its name, the asset or scope, the trade, the contractor and when it was due", () => {
    const report = run({
      schedules: [
        nextDue("2026-10-10", { AssetId: 5, AssetName: "Chiller 1", AssetTag: "CH-01", Category: "hvac / mechanical", ContractorId: 10, ContractorName: " Cool Air ", Name: "Chiller service", ServiceScheduleId: 41 }),
        nextDue("2026-10-05", { Category: "", Name: "Exit lights", Scope: "All emergency exit lights", ServiceScheduleId: 42 }),
      ],
    });
    expect(overdue(report)).toEqual([
      { contractorName: null, daysOverdue: 18, dueDate: "2026-10-05", name: "Exit lights", serviceScheduleId: 42, target: "All emergency exit lights", trade: "Not categorised" },
      { contractorName: "Cool Air", daysOverdue: 13, dueDate: "2026-10-10", name: "Chiller service", serviceScheduleId: 41, target: "Chiller 1 (CH-01)", trade: "HVAC / mechanical" },
    ]);
  });
});

describe("defects periods in force", () => {
  const inForce = (report: ReturnType<typeof run>) => building(report, 3)?.defectsPeriods ?? [];

  it.each([
    ["starts on the date", "2026-10-23", "2027-06-30", true],
    ["ends on the date", "2026-06-30", "2026-10-23", true],
    ["started yesterday", "2026-10-22", "2027-06-30", true],
    ["starts tomorrow", "2026-10-24", "2027-06-30", false],
    ["ended yesterday", "2026-06-30", "2026-10-22", false],
  ])("a period that %s is in force: %s", (_name, PracticalCompletion, EndsOn, expected) => {
    const report = run({ periods: [period({ EndsOn, PracticalCompletion })] });
    expect(inForce(report)).toHaveLength(expected ? 1 : 0);
    expect(report.totals.defectsPeriods).toBe(expected ? 1 : 0);
  });

  it("checks against the report's date", () => {
    const row = period({ EndsOn: "2026-12-31", PracticalCompletion: "2026-06-30" });
    expect(inForce(run({ periods: [row] }))).toHaveLength(1);
    expect(inForce(run({ periods: [row] }, ALL, "2027-01-01"))).toHaveLength(0);
  });

  it("never counts an archived period", () => {
    expect(run({ periods: [period({ ArchivedAt: new Date("2026-09-01T00:00:00Z") })] }).buildings).toEqual([]);
  });

  it("says whether it blocks planned maintenance, what it covers and who owes the rectification, soonest to end first", () => {
    const report = run({
      periods: [
        period({ ContractorName: "Builder Co", DefectsPeriodId: 51, EndsOn: "2027-06-30", Services: JSON.stringify(["HVAC / mechanical", "Lifts"]) }),
        period({ DefectsPeriodId: 52, EndsOn: "2026-12-31", Enforcement: "warn", LevelName: "Level 3", Scope: "level", Works: "Level 3 fit-out" }),
        period({ DefectsPeriodId: 53, EndsOn: "2027-01-31", Scope: "tenancy", TenantId: 9, TenantName: "Acme Pty Ltd" }),
      ],
    });
    expect(inForce(report)).toEqual([
      { contractorName: null, defectsPeriodId: 52, endsOn: "2026-12-31", enforcement: "warn", levelName: "Level 3", scope: "level", services: "all", startsOn: "2026-06-30", tenantName: null, works: "Level 3 fit-out" },
      { contractorName: null, defectsPeriodId: 53, endsOn: "2027-01-31", enforcement: "block", levelName: null, scope: "tenancy", services: "all", startsOn: "2026-06-30", tenantName: "Acme Pty Ltd", works: "Level 2 fit-out" },
      { contractorName: "Builder Co", defectsPeriodId: 51, endsOn: "2027-06-30", enforcement: "block", levelName: null, scope: "building", services: ["HVAC / mechanical", "Lifts"], startsOn: "2026-06-30", tenantName: null, works: "Level 2 fit-out" },
    ]);
  });
});

describe("commercial buildings only", () => {
  const stray = { BuildingId: 9 };

  it("drops every row for a building the read didn't return, so a residence can't appear even if a read were loosened", () => {
    const report = run({
      certificates: [],
      contractors: [contractor(10, "Cool Air")],
      periods: [period(stray)],
      plans: [plan(9, [{ contractorIds: [], required: true, trade: "Lifts" }])],
      schedules: [schedule({ ...stray, ContractorId: 10, NextDue: "2026-10-01" })],
    });
    expect(report.buildings).toEqual([]);
    expect(report.checked).toEqual({ buildings: 2, contractors: 0, requiredTrades: 0, schedules: 0 });
    expect(report.totals).toEqual({ buildingsWithFindings: 0, certificates: 0, defectsPeriods: 0, overdueSchedules: 0, tradeGaps: 0 });
  });
});

describe("the whole report", () => {
  const busy: Partial<ComplianceData> = {
    contractors: [contractor(10, "Cool Air")],
    periods: [period({ BuildingId: 7 })],
    plans: [plan(3, [{ contractorIds: [], required: true, trade: "Lifts" }])],
    schedules: [schedule({ BuildingId: 3, ContractorId: 10, NextDue: "2026-10-01" })],
  };

  it("lists only the buildings with something to show for all buildings, alphabetically, with totals that add up", () => {
    const report = run({ ...busy, schedules: [...(busy.schedules ?? []), schedule({ BuildingId: 7 })] });
    expect(report.buildings.map((entry) => entry.name)).toEqual(["Alpha House", "Bravo Tower"]);
    expect(report.totals).toEqual({ buildingsWithFindings: 2, certificates: 1, defectsPeriods: 1, overdueSchedules: 1, tradeGaps: 1 });
    expect(report.checked).toEqual({ buildings: 2, contractors: 1, requiredTrades: 1, schedules: 2 });
  });

  it("leaves out a building with nothing to show for all buildings, but still counts it as checked", () => {
    const report = run({ ...busy, periods: [] });
    expect(report.buildings.map((entry) => entry.buildingId)).toEqual([3]);
    expect(report.checked.buildings).toBe(2);
  });

  it("shows the one building asked for even when there is nothing to show", () => {
    const report = run({}, { buildingId: 7 });
    expect(report.buildings).toEqual([{ buildingId: 7, certificates: [], defectsPeriods: [], name: "Bravo Tower", overdueSchedules: [], referenceCode: "BR", tradeGaps: [] }]);
    expect(report.totals.buildingsWithFindings).toBe(0);
    expect(report.checked.buildings).toBe(1);
  });

  it("reports an empty portfolio as empty, not as an error", () => {
    const report = run({ buildings: [] });
    expect(report).toMatchObject({ buildings: [], checked: { buildings: 0 } });
  });

  it("carries the date and when it was made", () => {
    expect(run({})).toMatchObject({ asOf: ASOF, generatedAt: "2026-10-23T05:00:00.000Z" });
  });
});
