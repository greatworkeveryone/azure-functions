/// <reference types="jest" />

jest.mock("./db", () => ({ executeQuery: jest.fn() }));

import { loadCompanyFilesView } from "./myob-company-files-view";

const { executeQuery } = require("./db") as { executeQuery: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const RP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const saved = { ...process.env };

beforeEach(() => {
  process.env = { ...saved, MYOB_COMPANY_FILE_ID: RP };
  executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.MyobCompanyFiles/.test(sql)) {
      return [{ CompanyFileId: DEMO, IsDemonstration: true, Mode: "read", Name: "Demo", RowVersion: Buffer.alloc(8, 1), UpdatedAt: new Date("2026-10-14T00:00:00Z"), UpdatedBy: "Johanne" }];
    }
    if (/FROM dbo\.MyobControls/.test(sql)) {
      return [
        { CompanyFileId: DEMO, Enabled: true, Operation: "purchases.read", PausedAll: false, RowVersion: Buffer.alloc(8) },
        { CompanyFileId: DEMO, Enabled: false, Operation: "orders.create", PausedAll: false, RowVersion: Buffer.alloc(8) },
      ];
    }
    if (/FROM dbo\.MyobAuth\b/.test(sql)) return [{ BusinessId: DEMO }];
    return [];
  });
});

afterAll(() => {
  process.env = saved;
});

describe("loadCompanyFilesView", () => {
  it("lists registered files with mode, last change and switched-on operations, plus the configured file not yet registered", async () => {
    const view = await loadCompanyFilesView({} as never);

    expect(view.files).toHaveLength(2);
    expect(view.files[0]).toMatchObject({
      companyFileId: DEMO,
      enabledOperations: ["purchases.read"],
      isDemonstration: true,
      linked: true,
      mode: "read",
      registered: true,
      updatedBy: "Johanne",
    });
    expect(view.files[1]).toMatchObject({ companyFileId: RP, configured: true, mode: "off", registered: false, rowVersion: "" });
  });
});
