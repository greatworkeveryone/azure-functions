/// <reference types="jest" />

import { parseCsv } from "./csv";
import type { MappingRefs } from "./mappingKinds";
import { planImport } from "./planImport";

const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const RP = "11111111-2222-4333-8444-555555555555"; // not registered
const SUP = "44444444-2222-4333-8444-555555555555";
const SUP2 = "55555555-2222-4333-8444-555555555555";
const ACC = "66666666-2222-4333-8444-555555555555";
const GST = "77777777-2222-4333-8444-555555555555";

const refs = (over: Partial<MappingRefs> = {}): MappingRefs => ({
  buildings: new Map([[3, "Smith St"]]),
  contractors: new Map([[12, { abn: "51824753556", name: "ACME Air" }], [13, { abn: null, name: "Bob's Plumbing" }]]),
  existing: new Map(),
  files: new Map([[DEMO, "Demo Pty Ltd"]]),
  ...over,
});
const plan = (kind: "accounts" | "buildings" | "suppliers", csv: string, r = refs()) => planImport(kind, parseCsv(csv), r);

describe("planImport: suppliers", () => {
  const HEAD = "company_file_id,contractor_id,contractor_name,supplier_uid,supplier_name,abn,tax_code_uid,tax_code\n";

  it("says what each row would do, in plain words, writing nothing", () => {
    const result = plan("suppliers", `${HEAD}${DEMO},12,ACME Air,${SUP.toUpperCase()},ACME Air Pty Ltd,51 824 753 556,${GST},GST\n`);
    expect(result.rows).toEqual([
      expect.objectContaining({
        after: { abn: "51824753556", supplierName: "ACME Air Pty Ltd", supplierUid: SUP, taxCode: "GST", taxCodeUid: GST },
        file: DEMO,
        key: `${DEMO}|12`,
        line: 2,
        matchBasis: "abn",
        message: "Adds contractor #12 ACME Air → MYOB supplier ACME Air Pty Ltd in Demo Pty Ltd",
        outcome: "add",
      }),
    ]);
    expect(result.counts).toEqual({ add: 1, change: 0, skip: 0, unchanged: 0 });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows a change before → after, and an unchanged row as such", () => {
    const existing = new Map([
      [`${DEMO}|12`, { rowVersion: "v1", values: { abn: "51824753556", supplierName: "ACME Air", supplierUid: SUP, taxCode: "GST", taxCodeUid: GST } }],
      [`${DEMO}|13`, { rowVersion: "v2", values: { abn: null, supplierName: "Bob's", supplierUid: SUP2, taxCode: null, taxCodeUid: null } }],
    ]);
    const result = plan("suppliers", `${HEAD}${DEMO},12,,${SUP2},ACME Air Pty Ltd,51824753556,${GST},GST\n${DEMO},13,,${SUP2},Bob's,,,\n`, refs({ existing }));
    expect(result.rows[0]).toMatchObject({
      before: { supplierName: "ACME Air", supplierUid: SUP },
      changes: [
        { after: "ACME Air Pty Ltd", before: "ACME Air", label: "Supplier name" },
        { after: SUP2, before: SUP, label: "Supplier UID" },
      ],
      outcome: "change",
      rowVersion: "v1",
    });
    expect(result.rows[0].message).toBe(`Changes contractor #12 ACME Air in Demo Pty Ltd: supplier name ACME Air → ACME Air Pty Ltd; supplier UID ${SUP} → ${SUP2}`);
    expect(result.rows[1]).toMatchObject({ message: "Contractor #13 Bob's Plumbing is already mapped this way in Demo Pty Ltd", outcome: "unchanged" });
    expect(result.counts).toEqual({ add: 0, change: 1, skip: 0, unchanged: 1 });
  });

  it.each([
    ["an unregistered company file", `${RP},12,,${SUP},ACME,,,`, `Skipped: company file ${RP} isn't registered with Floorplan (Admin → MYOB → Entities)`],
    ["an unknown contractor", `${DEMO},99,,${SUP},ACME,,,`, "Skipped: Floorplan has no contractor #99"],
    ["a supplier UID that isn't one", `${DEMO},12,,ACME-1,ACME,,,`, "Skipped: supplier_uid must be a MYOB UID (like 0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766)"],
    ["a missing supplier name", `${DEMO},12,,${SUP},,,,`, "Skipped: supplier_name is empty"],
    ["an ABN that isn't 11 digits", `${DEMO},12,,${SUP},ACME,1234,,`, "Skipped: abn must be 11 digits"],
    ["a contractor id that isn't a number", `${DEMO},x12,,${SUP},ACME,,,`, "Skipped: contractor_id must be a Floorplan contractor number"],
  ])("skips %s, saying why", (_label, line, message) => {
    const result = plan("suppliers", `${HEAD}${line}\n`);
    expect(result.rows[0]).toMatchObject({ message, outcome: "skip" });
    expect(result.counts.skip).toBe(1);
  });

  it("uses the first of two rows for the same contractor and file, and says so", () => {
    const result = plan("suppliers", `${HEAD}${DEMO},12,,${SUP},ACME,,,\n${DEMO},12,,${SUP2},ACME 2,,,\n`);
    expect(result.rows[1]).toMatchObject({ message: "Skipped: contractor #12 ACME Air in Demo Pty Ltd is already on row 2", outcome: "skip" });
  });

  it("marks a match by ABN only when the ABN is the contractor's own", () => {
    expect(plan("suppliers", `${HEAD}${DEMO},12,,${SUP},ACME,,,\n`).rows[0].matchBasis).toBe("manual");
    expect(plan("suppliers", `${HEAD}${DEMO},12,,${SUP},ACME,11111111111,,\n`).rows[0].matchBasis).toBe("manual");
  });

  it("refuses a file without the columns it needs", () => {
    expect(() => plan("suppliers", "company_file_id,contractor_id\nx,1\n")).toThrow("supplier_uid, supplier_name");
  });

  it("gives a different fingerprint when what is in Floorplan changed since the preview", () => {
    const csv = `${HEAD}${DEMO},12,,${SUP},ACME,,,\n`;
    const before = plan("suppliers", csv).hash;
    const existing = new Map([[`${DEMO}|12`, { rowVersion: "v9", values: { abn: null, supplierName: "Other", supplierUid: SUP2, taxCode: null, taxCodeUid: null } }]]);
    expect(plan("suppliers", csv, refs({ existing })).hash).not.toBe(before);
  });
});

describe("planImport: accounts", () => {
  const HEAD = "company_file_id,charge_code,account_uid,account_display_id,account_name,tax_code_uid,tax_code\n";

  it("maps a Floorplan charge code to a MYOB account", () => {
    const result = plan("accounts", `${HEAD}${DEMO},M,${ACC},6-1100,Repairs,${GST},GST\n`);
    expect(result.rows[0]).toMatchObject({
      after: { accountDisplayId: "6-1100", accountName: "Repairs", accountUid: ACC, taxCode: "GST", taxCodeUid: GST },
      key: `${DEMO}|m`,
      message: "Adds charge code m (Maintenance) → MYOB account 6-1100 Repairs in Demo Pty Ltd",
      outcome: "add",
    });
  });

  it("skips a charge code Floorplan doesn't have", () => {
    expect(plan("accounts", `${HEAD}${DEMO},zz,${ACC},,,,\n`).rows[0]).toMatchObject({ message: "Skipped: zz isn't one of Floorplan's charge codes", outcome: "skip" });
  });
});

describe("planImport: buildings", () => {
  const HEAD = "building_id,building_name,company_file_id\n";

  it("maps a building to a registered company file, and shows a move between files", () => {
    expect(plan("buildings", `${HEAD}3,Smith St,${DEMO}\n`).rows[0]).toMatchObject({ file: DEMO, key: "3", message: "Adds building #3 Smith St → Demo Pty Ltd", outcome: "add" });
    const OTHER = "22222222-2222-4333-8444-555555555555";
    const moved = plan("buildings", `${HEAD}3,,${DEMO}\n`, refs({ existing: new Map([["3", { rowVersion: "v1", values: { companyFileId: OTHER } }]]), files: new Map([[DEMO, "Demo Pty Ltd"], [OTHER, "Other Pty Ltd"]]) }));
    expect(moved.rows[0]).toMatchObject({ changes: [{ after: "Demo Pty Ltd", before: "Other Pty Ltd", label: "Company file" }], outcome: "change" });
  });

  it("skips a building Floorplan doesn't have, or a file that isn't registered", () => {
    expect(plan("buildings", `${HEAD}8,,${DEMO}\n`).rows[0].message).toBe("Skipped: Floorplan has no building #8");
    expect(plan("buildings", `${HEAD}3,,${RP}\n`).rows[0].outcome).toBe("skip");
  });
});
