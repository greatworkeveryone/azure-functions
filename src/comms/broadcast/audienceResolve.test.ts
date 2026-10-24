import { addressesIn, combine, dateText, resolveContractors, resolveStaff, resolveTenancies, resolveTyped } from "./audienceResolve";
import type { ContractorRow, OccupancyRow, TenancyRow } from "./types";

const tenancy = (over: Partial<TenancyRow> = {}): TenancyRow => ({
  accountsEmail: "accounts@acme.example", buildingAddress: "1 Smith St, Darwin", buildingCategory: "commercial", buildingId: 5, buildingName: "Mooney Plaza",
  commencement: "2024-03-01", expiry: "2027-02-28", isTest: false, legalName: "Acme Pty Ltd", nextReviewDate: "2026-12-01",
  primaryContactEmail: "pat@acme.example", primaryContactName: "Pat Smith", tenantId: 44, ...over,
});
const occupancy = (tenantId: number, level: string, area = "Suite 1", buildingId = 5): OccupancyRow => ({ area, buildingId, level, tenantId });
const request = (over: Record<string, unknown> = {}) => ({ categories: ["commercial" as const], contacts: ["primary" as const, "accounts" as const], selections: [{ buildingId: 5, levels: [] as string[] }], ...over });

describe("tenancy contacts", () => {
  it("gives each selected contact with the tenancy's merge values, dates as DD/MM/YYYY", () => {
    const { candidates, excluded } = resolveTenancies(request(), { occupancies: [occupancy(44, "Level 2", "Suite 3")], tenancies: [tenancy()] });
    expect(excluded).toEqual([]);
    expect(candidates.map((c) => c.address)).toEqual(["pat@acme.example", "accounts@acme.example"]);
    expect(candidates[0]).toMatchObject({
      mergeValues: { "building.address": "1 Smith St, Darwin", "building.name": "Mooney Plaza", "tenant.addressee": "Pat Smith", "tenant.contact": "Pat Smith", "tenant.leaseExpiry": "28/02/2027", "tenant.leaseStart": "01/03/2024", "tenant.name": "Acme Pty Ltd", "tenant.nextReview": "01/12/2026", "tenant.suite": "Level 2, Suite 3" },
      name: "Pat Smith", recipientRefId: "44", recipientType: "tenancy",
    });
  });

  it("has no contact name for the accounts address, so a greeting falls back to the tenant's name", () => {
    const { candidates } = resolveTenancies(request({ contacts: ["accounts"] }), { occupancies: [], tenancies: [tenancy()] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBeNull();
    expect(candidates[0].mergeValues).not.toHaveProperty("tenant.addressee");
    expect(candidates[0].mergeValues).not.toHaveProperty("tenant.contact");
  });

  it("takes only the chosen contacts", () => {
    const { candidates } = resolveTenancies(request({ contacts: ["primary"] }), { occupancies: [], tenancies: [tenancy()] });
    expect(candidates.map((c) => c.address)).toEqual(["pat@acme.example"]);
  });

  it("limits to chosen levels: a tenancy with an area on a chosen level, case-insensitively, and none without", () => {
    const tenancies = [tenancy({ tenantId: 1, legalName: "On two" }), tenancy({ tenantId: 2, legalName: "On three", primaryContactEmail: "b@x.com" }), tenancy({ tenantId: 3, legalName: "No areas", primaryContactEmail: "c@x.com" })];
    const occupancies = [occupancy(1, "Level 2"), occupancy(2, "Level 3"), occupancy(2, "level 2", "Suite 9")];
    const { candidates } = resolveTenancies(request({ contacts: ["primary"], selections: [{ buildingId: 5, levels: ["LEVEL 2"] }] }), { occupancies, tenancies });
    expect(candidates.map((c) => c.recipientRefId)).toEqual(["1", "2"]);
  });

  it("keeps a whole-building choice to every active tenancy there, including one with no areas on file", () => {
    const { candidates } = resolveTenancies(request({ contacts: ["primary"] }), { occupancies: [], tenancies: [tenancy({ tenantId: 1 }), tenancy({ tenantId: 2, primaryContactEmail: "b@x.com" })] });
    expect(candidates).toHaveLength(2);
  });

  it("does not repeat a tenancy two selections both reach", () => {
    const { candidates } = resolveTenancies(request({ contacts: ["primary"], selections: [{ buildingId: 5, levels: ["Level 2"] }, { buildingId: 5, levels: [] }] }), { occupancies: [occupancy(44, "Level 2")], tenancies: [tenancy()] });
    expect(candidates).toHaveLength(1);
  });

  it("leaves out buildings of a category that was not chosen, and takes residences when chosen", () => {
    const house = tenancy({ buildingCategory: "residence", tenantId: 9 });
    expect(resolveTenancies(request(), { occupancies: [], tenancies: [house] }).candidates).toEqual([]);
    expect(resolveTenancies(request({ categories: ["commercial", "residence"] }), { occupancies: [], tenancies: [house] }).candidates).toHaveLength(2);
  });

  it("lists a test tenancy once as left out, with no address", () => {
    const { candidates, excluded } = resolveTenancies(request(), { occupancies: [], tenancies: [tenancy({ isTest: true })] });
    expect(candidates).toEqual([]);
    expect(excluded).toEqual([{ address: null, description: "Acme Pty Ltd at Mooney Plaza", reason: "test_record", source: "tenancy" }]);
  });

  it("lists a missing and an invalid address with the reason, and carries on with the others", () => {
    const { candidates, excluded } = resolveTenancies(request(), { occupancies: [], tenancies: [tenancy({ accountsEmail: null, primaryContactEmail: "not an address" })] });
    expect(candidates).toEqual([]);
    expect(excluded.map(({ address, reason }) => ({ address, reason }))).toEqual([{ address: "not", reason: "invalid_address" }, { address: "an", reason: "invalid_address" }, { address: "address", reason: "invalid_address" }, { address: null, reason: "no_address" }]);
  });

  it("splits a field holding several addresses and gives the name to none of them", () => {
    const { candidates } = resolveTenancies(request({ contacts: ["primary"] }), { occupancies: [], tenancies: [tenancy({ primaryContactEmail: "a@x.com; B@X.com, a@x.com" })] });
    expect(candidates.map((c) => c.address)).toEqual(["a@x.com", "b@x.com"]);
    expect(candidates.every((c) => c.name === null)).toBe(true);
  });

  it("leaves out a value the register has not got, and clips a long one", () => {
    const { candidates } = resolveTenancies(request({ contacts: ["primary"] }), { occupancies: [occupancy(44, "L".repeat(600))], tenancies: [tenancy({ expiry: "end of 2027", primaryContactName: null })] });
    expect(candidates[0].mergeValues).not.toHaveProperty("tenant.leaseExpiry");
    expect(candidates[0].mergeValues).not.toHaveProperty("tenant.contact");
    expect(candidates[0].mergeValues["tenant.suite"]).toHaveLength(500);
  });
});

describe("contractors", () => {
  const contractors: ContractorRow[] = [
    { contactName: "Sam Spark", contractorId: 1, email: "sam@sparks.example", name: "Sparks" },
    { contactName: null, contractorId: 2, email: "office@pipes.example", name: "Pipes" },
    { contactName: null, contractorId: 3, email: null, name: "Sparky Two" },
  ];
  const profiles = new Map([[1, ["Electrical"]], [2, ["Plumbing", "Drainage"]], [3, ["electrical"]]]);

  it("picks by trade from each contractor's own list, ignoring case, and lists the one with no address", () => {
    const { candidates, excluded } = resolveContractors({ buildingIds: [], trades: ["ELECTRICAL"] }, { assignedAtBuildings: new Set(), contractors, profiles });
    expect(candidates).toMatchObject([{ address: "sam@sparks.example", name: "Sam Spark", recipientRefId: "1", recipientType: "contractor" }]);
    expect(excluded).toEqual([{ address: null, description: "Sparky Two", reason: "no_address", source: "contractor" }]);
  });

  it("picks by building from the coverage plan alone when buildings are chosen", () => {
    const { candidates } = resolveContractors({ buildingIds: [5], trades: ["Electrical"] }, { assignedAtBuildings: new Set([2]), contractors, profiles });
    expect(candidates.map((c) => c.recipientRefId)).toEqual(["2"]);
  });

  it("names the company when there is no contact name", () => {
    const { candidates } = resolveContractors({ buildingIds: [], trades: ["Plumbing"] }, { assignedAtBuildings: new Set(), contractors, profiles });
    expect(candidates[0].name).toBe("Pipes");
  });
});

describe("staff and typed addresses", () => {
  it("lists staff by role with the role in words", () => {
    const { candidates } = resolveStaff([{ email: "fay@randazzo.properties", name: "Fay", role: "facilities_manager", userId: 7 }]);
    expect(candidates[0]).toMatchObject({ description: "Fay, facilities manager", recipientRefId: "7", recipientType: "staff" });
  });

  it("checks each typed address and lists the ones that fail", () => {
    const { candidates, excluded } = resolveTyped(["Pat@Example.com", "nope", "a@b"]);
    expect(candidates.map((c) => [c.address, c.recipientType])).toEqual([["pat@example.com", "manual"]]);
    expect(excluded.map((e) => [e.address, e.reason])).toEqual([["nope", "invalid_address"], ["a@b", "invalid_address"]]);
  });
});

describe("combine", () => {
  it("de-duplicates by address ignoring case, keeps the record with the most merge values, and counts what is left", () => {
    const thin = resolveTyped(["PAT@acme.example", "x@y.com"]);
    const rich = resolveTenancies(request({ contacts: ["primary"] }), { occupancies: [], tenancies: [tenancy()] });
    const staff = resolveStaff([{ email: "pat@acme.example", name: "Pat Staff", role: "facilities", userId: 1 }, { email: "z@randazzo.properties", name: "Zed", role: "director", userId: 2 }]);
    const audience = combine([thin, rich, staff]);
    expect(audience.recipients.map((r) => r.address)).toEqual(["pat@acme.example", "x@y.com", "z@randazzo.properties"]);
    const pat = audience.recipients[0];
    expect(pat.recipientType).toBe("tenancy");
    expect(pat.mergeValues["tenant.name"]).toBe("Acme Pty Ltd");
    expect(pat.sources).toEqual(["tenancy", "manual", "staff"]);
    expect(audience.counts).toEqual({ contractor: 0, duplicatesMerged: 2, manual: 1, staff: 1, tenancy: 1, total: 3 });
  });

  it("keeps the first of equal records, and carries every exclusion through", () => {
    const first = resolveStaff([{ email: "a@x.com", name: "First", role: "facilities", userId: 1 }]);
    const second = resolveStaff([{ email: "a@x.com", name: "Second", role: "accounts", userId: 2 }]);
    const lost = resolveTyped(["bad"]);
    const audience = combine([first, second, lost]);
    expect(audience.recipients[0].name).toBe("First");
    expect(audience.excluded).toHaveLength(1);
  });

  it("is empty for an empty audience", () => {
    expect(combine([])).toEqual({ counts: { contractor: 0, duplicatesMerged: 0, manual: 0, staff: 0, tenancy: 0, total: 0 }, excluded: [], recipients: [] });
  });
});

describe("helpers", () => {
  it("formats dates and splits addresses", () => {
    expect(dateText("2026-10-24")).toBe("24/10/2026");
    expect(dateText("soon")).toBeNull();
    expect(dateText(null)).toBeNull();
    expect(addressesIn(null)).toEqual({ invalid: [], valid: [] });
  });
});
