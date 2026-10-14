/// <reference types="jest" />

jest.mock("./db", () => ({ executeQuery: jest.fn() }));

import { loadControlsView } from "./myob-controls-view";

const { executeQuery } = require("./db") as { executeQuery: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const RP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const saved = { ...process.env };

beforeEach(() => {
  process.env = { ...saved, MYOB_COMPANY_FILE_ID: RP.toUpperCase(), MYOB_WRITES_ENABLED: "false" };
  executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.MyobCompanyFiles/.test(sql)) return [{ CompanyFileId: DEMO, IsDemonstration: true, Mode: "write", Name: "Demo Co" }];
    if (/FROM dbo\.MyobAuth\b/.test(sql)) return [{ BusinessId: DEMO }];
    if (/FROM dbo\.MyobControls/.test(sql)) {
      return [
        { CompanyFileId: DEMO, DailyCap: 3, DryRun: false, Enabled: true, Operation: "orders.create", PausedAll: true, RequireReview: true, RowVersion: Buffer.alloc(8, 1) },
      ];
    }
    if (/FROM dbo\.MyobApiLog/.test(sql)) return [{ Calls: 2, Method: "POST", Path: `/accountright/${DEMO}/Purchase/Order/Service` }];
    return [];
  });
});

afterAll(() => {
  process.env = saved;
});

describe("loadControlsView", () => {
  it("lists registered, configured and linked files once each, with all seven controls", async () => {
    const view = await loadControlsView({} as never, new Date("2026-10-14T01:00:00Z"));

    expect(view).toMatchObject({ configuredFileId: RP, linkedFileId: DEMO, masterWritesEnabled: false });
    expect(view.files.map((f) => f.companyFileId)).toEqual([DEMO, RP]);
    for (const file of view.files) expect(file.controls).toHaveLength(7);
  });

  it("shows set-up rows with today's use, and defaults (all off) where nothing is set up", async () => {
    const view = await loadControlsView({} as never, new Date("2026-10-14T01:00:00Z"));
    const demo = view.files[0];
    const rp = view.files[1];

    expect(demo).toMatchObject({ isDemonstration: true, mode: "write", name: "Demo Co", paused: true, registered: true });
    expect(demo.controls.find((c) => c.operation === "orders.create")).toMatchObject({ dailyCap: 3, enabled: true, setUp: true, usedToday: 2 });
    expect(rp).toMatchObject({ mode: "off", paused: false, registered: false });
    expect(rp.controls.every((c) => !c.setUp && !c.enabled && c.dryRun && c.dailyCap === 0 && c.rowVersion === "")).toBe(true);
  });
});
