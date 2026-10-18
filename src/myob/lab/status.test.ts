/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));

import { loadLabStatus } from "./status";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const RP = "abcdef12-2222-4333-8444-5555555555ee";
const OTHER = "22222222-2222-4333-8444-555555555555";
const file = (id: string, mode: string, demo: boolean, name = "File") => ({ CompanyFileId: id, IsDemonstration: demo, Mode: mode, Name: name });
const link = { BusinessId: DEMO, MyobUsername: "floorplan@demo", Scope: "sme-company-file sme-purchases" };
const world = (files: unknown[], auth: unknown[] = [link]) =>
  executeQuery.mockImplementation(async (_c: unknown, sql: string) => (sql.includes("MyobCompanyFiles") ? files : sql.includes("MyobAuth") ? auth : []));
const ENV = { MYOB_RP_COMPANY_FILE_ID: RP };

beforeEach(() => jest.clearAllMocks());

describe("loadLabStatus", () => {
  it("is ready when exactly one non-RP file is the demonstration file, the only one in write mode, linked with the agreed scopes", async () => {
    world([file(DEMO, "write", true, "MYOB sample"), file(RP, "off", false, "Randazzo Properties"), file(OTHER, "read", false)]);
    expect(await loadLabStatus({} as never, ENV)).toEqual({
      demoFile: { id: DEMO, mode: "write", name: "MYOB sample" },
      link: { businessId: DEMO, scope: "sme-company-file sme-purchases", username: "floorplan@demo" },
      problems: [],
      ready: true,
      rpFile: { id: RP, name: "Randazzo Properties" },
    });
  });

  it("names RP's file by its registered name, or says it isn't registered", async () => {
    world([file(DEMO, "write", true, "MYOB sample")]);
    expect((await loadLabStatus({} as never, { MYOB_RP_COMPANY_FILE_ID: ` ${RP.toUpperCase()} ` })).rpFile).toEqual({ id: RP, name: null });
    expect((await loadLabStatus({} as never, {})).rpFile).toBeNull();
  });

  it("is not ready while Floorplan's MYOB link is to another file than the demonstration file", async () => {
    world([file(DEMO, "write", true, "MYOB sample"), file(RP, "off", false, "Randazzo Properties")], [{ ...link, BusinessId: RP.toUpperCase() }]);
    const status = await loadLabStatus({} as never, ENV);
    expect(status.ready).toBe(false);
    expect(status.problems).toContain("Floorplan's MYOB link is to Randazzo Properties, not MYOB sample: link it to the demonstration file as your restricted MYOB user (Admin → MYOB → Connection)");
  });

  it.each([
    ["no demonstration file", [file(RP, "off", false)], /No company file is flagged as the demonstration file/],
    ["two demonstration files", [file(DEMO, "write", true), file(OTHER, "write", true)], /More than one/],
    ["RP's own file flagged as the demonstration file", [file(RP, "write", true)], /is RP's own file/],
    ["the demonstration file not in write mode", [file(DEMO, "read", true)], /isn't set to read and create/],
    ["another file in write mode", [file(DEMO, "write", true), file(OTHER, "write", false, "Other")], /Other is also set to read and create/],
  ])("is not ready with %s", async (_label, files, problem) => {
    world(files);
    const status = await loadLabStatus({} as never, ENV);
    expect(status.ready).toBe(false);
    expect(status.problems.join(" ")).toMatch(problem);
  });

  it("is not ready without RP's file id to keep the lab away from, or without the agreed scopes", async () => {
    world([file(DEMO, "write", true)]);
    expect((await loadLabStatus({} as never, {})).problems.join(" ")).toMatch(/MYOB_RP_COMPANY_FILE_ID/);
    world([file(DEMO, "write", true)], [{ ...link, Scope: "sme-company-file sme-purchases sme-contact" }]);
    expect((await loadLabStatus({} as never, ENV)).problems.join(" ")).toMatch(/scope/);
    world([file(DEMO, "write", true)], []);
    expect((await loadLabStatus({} as never, ENV)).problems.join(" ")).toMatch(/not linked/);
  });
});
