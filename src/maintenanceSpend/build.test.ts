/// <reference types="jest" />
import { buildMaintenanceSpend } from "./build";
import { financialYear } from "./financialYear";
import { exGstCents, toCents } from "./gst";
import type { MaintenanceSpendScope } from "./types";

// The Maintenance spend rules, on fixtures: ex GST, the Darwin financial-year edge, the approval-date
// fallback, on-charges, commercial buildings only, and the totals that follow from them.

const FY = financialYear(2025);
const ALL: MaintenanceSpendScope = { all: true };
const BUILDINGS = [
  { BuildingID: 7, BuildingName: "Bravo Tower", ReferenceCode: "BR" },
  { BuildingID: 3, BuildingName: "Alpha House", ReferenceCode: "AL" },
];
const INSIDE = "2025-10-15T00:00:00Z";

let nextId = 1;
const invoice = (over: Record<string, unknown> = {}) => ({
  Amount: 110,
  ApprovedAt: null,
  BuildingID: 3,
  Category: "Electrical",
  Direction: "incoming",
  IsOnchargeable: false,
  JobID: nextId++,
  JobInvoiceID: nextId++,
  ReceivedAt: new Date(INSIDE),
  ...over,
});

const run = (invoices: Record<string, unknown>[], scope: MaintenanceSpendScope = ALL, year = FY) =>
  buildMaintenanceSpend({ data: { buildings: BUILDINGS, invoices }, financialYear: year, generatedAt: "2026-10-23T01:00:00.000Z", scope });

const alpha = (report: ReturnType<typeof run>) => report.buildings.find((building) => building.buildingId === 3);

describe("ex GST", () => {
  it("takes GST out of the recorded total: an eleventh, to the cent", () => {
    expect(exGstCents(11000)).toBe(10000);
    expect(exGstCents(10000)).toBe(9091);
    expect(exGstCents(100)).toBe(91);
    expect(toCents("110.00")).toBe(11000);
    expect(toCents(null)).toBeNull();
    expect(toCents("abc")).toBeNull();
  });

  it("reports spend ex GST per building and trade, and says nothing about the recorded total", () => {
    const report = run([invoice({ Amount: 110 }), invoice({ Amount: 220 }), invoice({ Amount: 1100, Category: "HVAC / mechanical" })]);
    expect(alpha(report)?.trades).toEqual([
      { jobCount: 1, onChargesRecovered: 0, spend: 1000, trade: "HVAC / mechanical" },
      { jobCount: 2, onChargesRecovered: 0, spend: 300, trade: "Electrical" },
    ]);
    expect(alpha(report)?.total).toEqual({ jobCount: 3, onChargesRecovered: 0, spend: 1300 });
  });

  it("rounds each invoice, so a group total is exactly the sum of its invoices", () => {
    // $0.50 inc GST is $0.45 ex GST; three of them are $1.35, not 1.50 / 1.1 = $1.36.
    const report = run([invoice({ Amount: 0.5 }), invoice({ Amount: 0.5 }), invoice({ Amount: 0.5 })]);
    expect(alpha(report)?.total.spend).toBe(1.35);
  });

  it("accepts an amount that arrives as text, and skips one that is missing or not a number", () => {
    const report = run([invoice({ Amount: "110.00" }), invoice({ Amount: null }), invoice({ Amount: "n/a" })]);
    expect(report.portfolio).toMatchObject({ jobCount: 1, spend: 100 });
  });
});

describe("the financial year, in Darwin time", () => {
  const landsIn = (iso: string, year = FY) => run([invoice({ ReceivedAt: new Date(iso) })], ALL, year).portfolio.jobCount === 1;

  it.each([
    ["23:30 Darwin on 30 June (14:00 UTC)", "2026-06-30T14:00:00Z", true, false],
    ["one second before midnight Darwin on 1 July", "2026-06-30T14:29:59Z", true, false],
    ["midnight Darwin on 1 July (14:30 UTC on 30 June)", "2026-06-30T14:30:00Z", false, true],
    ["09:00 Darwin on 1 July (23:30 UTC on 30 June)", "2026-06-30T23:30:00Z", false, true],
    ["midnight Darwin on 1 July 2025", "2025-06-30T14:30:00Z", true, false],
    ["one second before it", "2025-06-30T14:29:59Z", false, false],
  ])("%s", (_name, iso, in2025, in2026) => {
    expect(landsIn(iso)).toBe(in2025);
    expect(landsIn(iso, financialYear(2026))).toBe(in2026);
  });

  it("leaves an invoice from another year out of the figures", () => {
    const report = run([invoice({ ReceivedAt: new Date("2024-10-01T00:00:00Z") }), invoice({ ReceivedAt: new Date("2026-08-01T00:00:00Z") })]);
    expect(report.buildings).toEqual([]);
    expect(report.portfolio).toEqual({ buildingCount: 0, jobCount: 0, onChargesRecovered: 0, spend: 0 });
  });

  it("names the year it is for", () => {
    expect(run([]).financialYear).toEqual({ from: "2025-07-01", label: "2025-26", to: "2026-06-30" });
  });
});

describe("the approval date, when an invoice has no invoice date", () => {
  it("counts it in the year it was approved, and counts how many fell back", () => {
    const report = run([
      invoice({ ApprovedAt: new Date("2025-11-01T00:00:00Z"), ReceivedAt: null }),
      invoice({ ApprovedAt: new Date("2025-11-02T00:00:00Z"), ReceivedAt: null }),
      invoice({ ApprovedAt: new Date("2025-11-02T00:00:00Z") }),
    ]);
    expect(report.portfolio.jobCount).toBe(3);
    expect(report.dating).toEqual({ approvalFallbacks: 2, undated: 0 });
  });

  it("uses the invoice date when there is one, even when the approval falls in another year", () => {
    const inYear = invoice({ ApprovedAt: new Date("2026-08-01T00:00:00Z"), ReceivedAt: new Date("2026-05-01T00:00:00Z") });
    const outOfYear = invoice({ ApprovedAt: new Date("2025-08-01T00:00:00Z"), ReceivedAt: new Date("2025-05-01T00:00:00Z") });
    const report = run([inYear, outOfYear]);
    expect(report.portfolio.jobCount).toBe(1);
    expect(report.dating.approvalFallbacks).toBe(0);
  });

  it("reads the approval date in Darwin time too", () => {
    const late = invoice({ ApprovedAt: new Date("2026-06-30T14:00:00Z"), ReceivedAt: null });
    expect(run([late]).portfolio.jobCount).toBe(1);
    expect(run([late], ALL, financialYear(2026)).portfolio.jobCount).toBe(0);
  });

  it("doesn't count a fallback for an invoice that is outside the year anyway", () => {
    const report = run([invoice({ ApprovedAt: new Date("2024-11-01T00:00:00Z"), ReceivedAt: null })]);
    expect(report.dating).toEqual({ approvalFallbacks: 0, undated: 0 });
  });

  it("leaves out an invoice with neither date, and counts it so the page can say so", () => {
    const report = run([invoice({ ApprovedAt: null, ReceivedAt: null }), invoice()]);
    expect(report.portfolio.jobCount).toBe(1);
    expect(report.dating.undated).toBe(1);
  });

  it("doesn't report an invoice that was never going to count as undated", () => {
    const report = run([invoice({ ApprovedAt: null, Direction: "outgoing", IsOnchargeable: false, ReceivedAt: null })]);
    expect(report.dating).toEqual({ approvalFallbacks: 0, undated: 0 });
  });
});

describe("on-charges recovered", () => {
  it("is the approved outgoing invoices on on-chargeable jobs, ex GST, beside the spend, and adds no job", () => {
    const report = run([
      invoice({ Amount: 1100, JobID: 50 }),
      invoice({ Amount: 330, Direction: "outgoing", IsOnchargeable: true, JobID: 50 }),
      invoice({ Amount: 220, Direction: "outgoing", IsOnchargeable: true, JobID: 50 }),
    ]);
    expect(alpha(report)?.trades).toEqual([{ jobCount: 1, onChargesRecovered: 500, spend: 1000, trade: "Electrical" }]);
    expect(report.portfolio).toMatchObject({ jobCount: 1, onChargesRecovered: 500, spend: 1000 });
  });

  it("ignores an outgoing invoice on a job that isn't on-chargeable, and any direction it doesn't know", () => {
    const report = run([
      invoice({ Amount: 110, Direction: "outgoing", IsOnchargeable: false }),
      invoice({ Amount: 110, Direction: "sideways", IsOnchargeable: true }),
    ]);
    expect(report.portfolio).toMatchObject({ jobCount: 0, onChargesRecovered: 0, spend: 0 });
    expect(report.buildings).toEqual([]);
  });

  it("treats a missing direction as incoming, as the rest of the app does", () => {
    expect(run([invoice({ Direction: null })]).portfolio.spend).toBe(100);
  });

  it("still lists a trade whose only figure in the year is a recovery", () => {
    const report = run([invoice({ Amount: 110, Direction: "outgoing", IsOnchargeable: true })]);
    expect(alpha(report)?.trades).toEqual([{ jobCount: 0, onChargesRecovered: 100, spend: 0, trade: "Electrical" }]);
  });
});

describe("commercial buildings only", () => {
  it("drops an invoice on a building the commercial read didn't return, so a residence never appears", () => {
    const report = run([invoice({ BuildingID: 9, Category: "Cleaning" }), invoice({ BuildingID: 3 })]);
    expect(report.buildings.map((building) => building.buildingId)).toEqual([3]);
    expect(report.portfolio).toMatchObject({ jobCount: 1, spend: 100 });
    expect(report.topTrades.map((trade) => trade.trade)).toEqual(["Electrical"]);
  });
});

describe("scope", () => {
  it("lists the buildings with figures in the year, by name, with each building's total and the portfolio's", () => {
    const report = run([invoice({ BuildingID: 7, Category: "Cleaning" }), invoice({ BuildingID: 3 }), invoice({ BuildingID: 3, Category: "Grounds" })]);
    expect(report.buildings.map((building) => [building.name, building.referenceCode])).toEqual([
      ["Alpha House", "AL"],
      ["Bravo Tower", "BR"],
    ]);
    expect(report.buildings[0].total).toEqual({ jobCount: 2, onChargesRecovered: 0, spend: 200 });
    expect(report.portfolio).toEqual({ buildingCount: 2, jobCount: 3, onChargesRecovered: 0, spend: 300 });
  });

  it("leaves out a building with nothing in the year for all buildings, and keeps the one asked for", () => {
    expect(run([invoice({ BuildingID: 3 })]).buildings.map((building) => building.buildingId)).toEqual([3]);
    const one = buildMaintenanceSpend({ data: { buildings: [BUILDINGS[0]], invoices: [] }, financialYear: FY, generatedAt: "x", scope: { buildingId: 7 } });
    expect(one.buildings).toEqual([{ buildingId: 7, name: "Bravo Tower", referenceCode: "BR", total: { jobCount: 0, onChargesRecovered: 0, spend: 0 }, trades: [] }]);
    expect(one.portfolio.buildingCount).toBe(1);
  });
});

describe("trades", () => {
  it("lists listed trades in their order, other text after, Not categorised last, grouping the same text whatever its case", () => {
    const report = run([
      invoice({ Category: null }),
      invoice({ Category: "Common Areas" }),
      invoice({ Category: "common areas" }),
      invoice({ Category: "Other" }),
      invoice({ Category: "electrical" }),
    ]);
    expect(alpha(report)?.trades.map((trade) => [trade.trade, trade.jobCount])).toEqual([
      ["Electrical", 1],
      ["Other", 1],
      ["Common Areas", 2],
      ["Not categorised", 1],
    ]);
  });

  it("counts a job once, however many invoices it has", () => {
    const report = run([invoice({ JobID: 99 }), invoice({ JobID: 99 }), invoice({ JobID: 99 })]);
    expect(alpha(report)?.trades[0]).toMatchObject({ jobCount: 1, spend: 300 });
  });
});

describe("top trades", () => {
  const spendOn = (category: string, amount: number, building = 3) => invoice({ Amount: amount, BuildingID: building, Category: category });

  it("ranks trades by spend across the buildings, five at most, with ties in the list's order", () => {
    const report = run([
      spendOn("Cleaning", 110),
      spendOn("Cleaning", 110, 7),
      spendOn("Electrical", 330),
      spendOn("Lifts", 220),
      spendOn("Grounds", 220),
      spendOn("Hydraulic", 55),
      spendOn("Compliance", 11),
      spendOn("Other", 1),
    ]);
    expect(report.topTrades.map((trade) => [trade.trade, trade.spend, trade.jobCount])).toEqual([
      ["Electrical", 300, 1],
      ["Lifts", 200, 1],
      ["Cleaning", 200, 2],
      ["Grounds", 200, 1],
      ["Hydraulic", 50, 1],
    ]);
  });

  it("leaves out a trade with no spend, and is empty when nothing was spent", () => {
    const report = run([invoice({ Amount: 110, Category: "Lifts", Direction: "outgoing", IsOnchargeable: true })]);
    expect(report.topTrades).toEqual([]);
  });
});

describe("the response", () => {
  it("carries when it was made", () => {
    expect(run([]).generatedAt).toBe("2026-10-23T01:00:00.000Z");
  });
});
