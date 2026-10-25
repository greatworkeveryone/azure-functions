/// <reference types="jest" />
// Recurring-fault signals (SC-AI5): which jobs belong together, when a group is a
// signal, the Darwin window and the approved spend. The route's own reads
// (archived, test, kind, scheduler jobs) are in getRecurringFaults.test.ts.
import {
  approvedCentsByJob,
  exGstCents,
  groupFaultJobs,
  recurringGroups,
  toSignals,
  tradeOfJob,
  windowStartUtc,
  type FaultAsset,
  type FaultJob,
} from "../recurringFaults";

const at = (iso: string): Date => new Date(iso);

const CHILLER: FaultAsset = { id: 12, label: "Chiller 1 (CH-01)", locationName: "Level 2 › Plant room" };
const LIFT: FaultAsset = { id: 13, label: "Lift 1", locationName: null };

let nextId = 100;
function job(overrides: Partial<FaultJob> = {}): FaultJob {
  nextId += 1;
  return {
    assets: [],
    buildingId: 1,
    buildingName: "30 Daly St",
    category: "HVAC / mechanical",
    createdAt: at("2026-09-01T02:00:00Z"),
    id: nextId,
    kind: "facilities",
    levelName: "Level 2",
    retiredAssetsOnly: false,
    status: "Work",
    title: "Air conditioning not cooling",
    type: null,
    ...overrides,
  };
}

/** `count` jobs a day apart, newest on `last`. */
function jobs(count: number, overrides: Partial<FaultJob> = {}, last = "2026-09-20T02:00:00Z"): FaultJob[] {
  return Array.from({ length: count }, (_, index) => job({ ...overrides, createdAt: new Date(at(last).getTime() - index * 86_400_000) }));
}

describe("windowStartUtc", () => {
  it("opens at Darwin midnight, 365 days before today, so the edge follows the Darwin day and not the UTC one", () => {
    // Darwin is 9h30 ahead: 23/10/2025 00:00 there is 22/10/2025 14:30 UTC.
    const since = windowStartUtc("2026-10-23");
    expect(since.toISOString()).toBe("2025-10-22T14:30:00.000Z");
    expect(at("2025-10-22T14:30:00.000Z") >= since).toBe(true);
    expect(at("2025-10-22T14:29:59.999Z") >= since).toBe(false);
  });

  it("counts 365 days across a leap day, and takes another window", () => {
    expect(windowStartUtc("2028-03-01").toISOString()).toBe("2027-03-01T14:30:00.000Z");
    expect(windowStartUtc("2026-10-23", 30).toISOString()).toBe("2026-09-22T14:30:00.000Z");
  });
});

describe("tradeOfJob", () => {
  it("is a maintenance job's category", () => {
    expect(tradeOfJob(job({ category: "Lifts", kind: "maintenance" }))).toBe("Lifts");
  });

  it("is the maintenance category a work-request type maps to, as defects periods read it", () => {
    expect(tradeOfJob(job({ category: "Common Areas", type: "Air Conditioning" }))).toBe("HVAC / mechanical");
    expect(tradeOfJob(job({ category: "Tenancy Works", type: "Plumbing" }))).toBe("Hydraulic");
  });

  it("keeps a maintenance category a reactive job was given directly, in the list's own spelling", () => {
    expect(tradeOfJob(job({ category: "hvac / mechanical", type: null }))).toBe("HVAC / mechanical");
  });

  it("uses a work-request type that maps to nothing as written, and never says 'Common Areas' is a trade", () => {
    expect(tradeOfJob(job({ category: "Common Areas", type: "Pest Control" }))).toBe("Pest Control");
    expect(tradeOfJob(job({ category: "Common Areas", type: null }))).toBeNull();
    expect(tradeOfJob(job({ category: null, type: "  " }))).toBeNull();
  });
});

describe("grouping", () => {
  it("puts jobs on one asset together, whatever their level or trade", () => {
    const list = [
      job({ assets: [CHILLER], category: "Electrical", levelName: "Level 1" }),
      job({ assets: [CHILLER], category: "HVAC / mechanical", levelName: null }),
      job({ assets: [CHILLER], category: null, levelName: "Level 9" }),
    ];
    const groups = groupFaultJobs(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ basis: "asset", key: "asset:12" });
    expect(groups[0].jobs).toHaveLength(3);
  });

  it("counts a job linked to two assets for both", () => {
    const shared = job({ assets: [CHILLER, LIFT] });
    const groups = groupFaultJobs([shared, job({ assets: [CHILLER] }), job({ assets: [LIFT] })]);
    expect(groups.map((group) => [group.key, group.jobs.length]).sort()).toEqual([["asset:12", 2], ["asset:13", 2]]);
  });

  it("puts jobs with no asset together by building, level and trade; spelling, case and spacing don't split them", () => {
    const list = [
      job({ createdAt: at("2026-09-03T02:00:00Z"), levelName: "Level 2", type: "Air Conditioning", category: "Common Areas" }),
      job({ createdAt: at("2026-09-02T02:00:00Z"), levelName: " level  2 ", category: "hvac / mechanical" }),
      job({ createdAt: at("2026-09-01T02:00:00Z"), levelName: "LEVEL 2", category: "HVAC / mechanical" }),
    ];
    const groups = groupFaultJobs(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ basis: "location", level: "Level 2", trade: "HVAC / mechanical" });
  });

  it("keeps a different building, level or trade apart", () => {
    const groups = groupFaultJobs([
      job({ buildingId: 2, buildingName: "Other" }),
      job({ levelName: "Level 3" }),
      job({ category: "Electrical" }),
      job(),
    ]);
    expect(groups).toHaveLength(4);
  });

  it("puts jobs with no level together by building and trade, apart from the ones that have a level", () => {
    const groups = groupFaultJobs([job({ levelName: null }), job({ levelName: "  " }), job({ levelName: "Level 2" })]);
    expect(groups.map((group) => [group.basis, group.jobs.length]).sort()).toEqual([["building", 2], ["location", 1]]);
  });

  it("leaves out a job with no asset and no trade, and one linked only to retired assets", () => {
    const list = [
      job({ category: "Common Areas", type: null }),
      job({ category: null, type: null }),
      job({ retiredAssetsOnly: true }),
    ];
    expect(groupFaultJobs(list)).toEqual([]);
  });

  it("groups reactive jobs whose work-request types map to the same trade", () => {
    const groups = groupFaultJobs([
      job({ category: "Common Areas", type: "Plumbing" }),
      job({ category: "Common Areas", type: "Hydraulics" }),
      job({ category: "Tenancy Works", type: "Plumbing" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].trade).toBe("Hydraulic");
  });
});

describe("the threshold", () => {
  it("makes a signal of three jobs, not two", () => {
    expect(recurringGroups(jobs(2))).toEqual([]);
    expect(recurringGroups(jobs(3))).toHaveLength(1);
    expect(recurringGroups(jobs(5))[0].jobs).toHaveLength(5);
  });

  it("takes another threshold, and counts each group on its own", () => {
    expect(recurringGroups(jobs(2), 2)).toHaveLength(1);
    expect(recurringGroups([...jobs(2), ...jobs(2, { category: "Electrical" })])).toEqual([]);
  });

  it("is empty for no jobs", () => {
    expect(recurringGroups([])).toEqual([]);
    expect(toSignals([], new Map())).toEqual([]);
  });
});

describe("a signal", () => {
  it("says how many jobs, how many are open, first and last dates, and lists the jobs newest first", () => {
    const list = [
      job({ createdAt: at("2026-03-10T02:00:00Z"), id: 1, status: "Done", title: "First" }),
      job({ createdAt: at("2026-06-10T02:00:00Z"), id: 2, status: "Work", title: "Second" }),
      job({ createdAt: at("2026-09-10T02:00:00Z"), id: 3, status: "New", title: "Third" }),
    ];
    const [signal] = toSignals(recurringGroups(list), new Map());
    expect(signal).toMatchObject({ firstOn: "2026-03-10", jobCount: 3, lastOn: "2026-09-10", openCount: 2, spendExGst: 0 });
    expect(signal.jobs).toEqual([
      { createdOn: "2026-09-10", id: 3, status: "New", title: "Third" },
      { createdOn: "2026-06-10", id: 2, status: "Work", title: "Second" },
      { createdOn: "2026-03-10", id: 1, status: "Done", title: "First" },
    ]);
  });

  it("dates a job by its Darwin day: late on the 1st in UTC is already the 2nd in Darwin", () => {
    const [signal] = toSignals(recurringGroups(jobs(3, {}, "2026-09-01T15:00:00Z")), new Map());
    expect(signal.lastOn).toBe("2026-09-02");
  });

  it("is labelled by the asset's name, or building, level and trade, and keeps where it is", () => {
    const [byAsset] = toSignals(recurringGroups(jobs(3, { assets: [CHILLER] })), new Map());
    expect(byAsset).toMatchObject({ assetId: 12, basis: "asset", label: "Chiller 1 (CH-01)", locationName: "Level 2 › Plant room", trade: null });

    const [byPlace] = toSignals(recurringGroups(jobs(3)), new Map());
    expect(byPlace).toMatchObject({ assetId: null, basis: "location", label: "30 Daly St · Level 2 · HVAC / mechanical", locationName: "Level 2", trade: "HVAC / mechanical" });

    const [noLevel] = toSignals(recurringGroups(jobs(3, { levelName: null })), new Map());
    expect(noLevel).toMatchObject({ basis: "building", label: "30 Daly St · HVAC / mechanical", locationName: null });
  });

  it("adds up the approved invoices of its jobs, excluding GST", () => {
    const list = jobs(3);
    const cents = new Map([[list[0].id, 110_000], [list[1].id, 55_000]]);
    expect(toSignals(recurringGroups(list), cents)[0].spendExGst).toBe(1500);
  });

  it("sorts by job count, then spend, then the most recent", () => {
    const four = jobs(4, { assets: [LIFT] });
    const cheap = jobs(3, { assets: [CHILLER] });
    const dear = jobs(3, { category: "Electrical" });
    const dearer = jobs(3, { category: "Cleaning" }, "2026-05-01T02:00:00Z");
    const cents = new Map([[dear[0].id, 330_000], [dearer[0].id, 330_000], [cheap[0].id, 11_000]]);
    const labels = toSignals(recurringGroups([...cheap, ...dear, ...four, ...dearer]), cents).map((signal) => signal.label);
    expect(labels).toEqual(["Lift 1", "30 Daly St · Level 2 · Electrical", "30 Daly St · Level 2 · Cleaning", "Chiller 1 (CH-01)"]);
  });
});

describe("approved spend", () => {
  const always = () => true;
  const never = () => false;

  it("counts director-approved invoices, and stage-1 ones only where no director is needed", () => {
    const invoices = [
      { amount: 1000, jobId: 1, status: "director_approved" },
      { amount: 200, jobId: 1, status: "approved" },
      { amount: 9000, jobId: 2, status: "approved" },
    ];
    expect([...approvedCentsByJob(invoices, (amount) => amount > 5000)]).toEqual([[1, 120_000]]);
    expect([...approvedCentsByJob(invoices, always)]).toEqual([[1, 100_000]]);
    expect(approvedCentsByJob(invoices, never).get(2)).toBe(900_000);
  });

  it("ignores anything not approved and amounts that are not known", () => {
    const invoices = [
      { amount: 500, jobId: 1, status: "pending" },
      { amount: 500, jobId: 1, status: "rejected" },
      { amount: null, jobId: 1, status: "director_approved" },
      { amount: Number.NaN, jobId: 1, status: "director_approved" },
    ];
    expect(approvedCentsByJob(invoices, never).size).toBe(0);
  });

  it("works in whole cents, so pennies do not drift", () => {
    expect(approvedCentsByJob([{ amount: 0.1, jobId: 1, status: "director_approved" }, { amount: 0.2, jobId: 1, status: "director_approved" }], never).get(1)).toBe(30);
  });

  it("takes GST off as a tenth of the total: 10/11 of what Floorplan holds", () => {
    expect(exGstCents(110_000)).toBe(100_000);
    expect(exGstCents(312_000)).toBe(283_636);
    expect(exGstCents(0)).toBe(0);
  });
});
