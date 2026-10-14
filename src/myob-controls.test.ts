/// <reference types="jest" />

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));

import { assertMyobControlsAllow, controlFor } from "./myob-controls";

const db = require("./db") as Record<string, jest.Mock>;
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const original = process.env.MYOB_COMPANY_FILE_ID;
const NOW = new Date("2026-10-14T01:00:00Z"); // 10:30 Darwin

type Row = Partial<{ Operation: string; Enabled: boolean; DryRun: boolean; DailyCap: number; PausedAll: boolean }>;
const control = (Operation: string, over: Row = {}) => ({
  DailyCap: 5,
  DryRun: false,
  Enabled: true,
  Operation,
  PausedAll: false,
  RequireReview: true,
  RowVersion: Buffer.alloc(8),
  ...over,
});

/** Controls for the file, then today's write rows from MyobApiLog. */
function world(controls: ReturnType<typeof control>[], writes: { Method: string; Path: string; Calls: number }[] = []) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    /FROM dbo\.MyobControls/.test(sql) ? controls : /FROM dbo\.MyobApiLog/.test(sql) ? writes : [],
  );
}

const allow = (operation: Parameters<typeof assertMyobControlsAllow>[0]["operation"], companyFileId: string | null = CF) =>
  assertMyobControlsAllow({ companyFileId, operation }, NOW);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MYOB_COMPANY_FILE_ID;
});

afterAll(() => {
  if (original === undefined) delete process.env.MYOB_COMPANY_FILE_ID;
  else process.env.MYOB_COMPANY_FILE_ID = original;
});

describe("controlFor", () => {
  it("governs every read by purchases.read and each write by its own switch", () => {
    expect(controlFor("files.list")).toBe("purchases.read");
    expect(controlFor("company_file.read")).toBe("purchases.read");
    expect(controlFor("purchases.read")).toBe("purchases.read");
    expect(controlFor("orders.create")).toBe("orders.create");
    expect(controlFor("quotes.update")).toBe("quotes.update");
  });
});

describe("boot guard", () => {
  it("refuses when the file has no controls", async () => {
    world([]);
    await expect(allow("purchases.read")).rejects.toMatchObject({ code: "controls" });
  });

  it("refuses, failing closed, when the controls table can't be read", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid object name 'dbo.MyobControls'"));
    await expect(allow("purchases.read")).rejects.toMatchObject({ code: "controls" });
  });

  it("uses the configured file for the file list, and refuses with neither", async () => {
    await expect(allow("files.list", null)).rejects.toMatchObject({ code: "controls" });
    expect(db.executeQuery).not.toHaveBeenCalled();

    process.env.MYOB_COMPANY_FILE_ID = CF.toUpperCase();
    world([control("purchases.read")]);
    await expect(allow("files.list", null)).resolves.toBeUndefined();
    expect(db.executeQuery.mock.calls[0][2][0].value).toBe(CF);
  });
});

describe("Johanne's switches", () => {
  it("lets an enabled read through", async () => {
    world([control("purchases.read")]);
    await expect(allow("purchases.read")).resolves.toBeUndefined();
  });

  it("refuses an operation that is switched off, or has no row", async () => {
    world([control("purchases.read"), control("orders.create", { Enabled: false })]);
    await expect(allow("orders.create")).rejects.toMatchObject({
      code: "controls",
      message: expect.stringContaining("orders.create is switched off"),
    });
    await expect(allow("quotes.create")).rejects.toMatchObject({ code: "controls" });
  });

  it("refuses everything, reads included, while the file is paused", async () => {
    world([control("purchases.read"), control("orders.create", { PausedAll: true })]);
    await expect(allow("purchases.read")).rejects.toMatchObject({ code: "controls", message: expect.stringContaining("paused") });
  });

  it("turns a write in dry run into a dry_run refusal: nothing is sent", async () => {
    world([control("orders.create", { DryRun: true })]);
    await expect(allow("orders.create")).rejects.toMatchObject({ code: "dry_run" });
  });

  it("refuses a write once today's allowance is used, counting this file's calls for that operation only", async () => {
    world(
      [control("orders.create", { DailyCap: 2 })],
      [
        { Calls: 2, Method: "POST", Path: `/accountright/${CF}/Purchase/Order/Service` },
        { Calls: 9, Method: "POST", Path: `/accountright/${CF}/Purchase/Quote/Service` },
        { Calls: 9, Method: "POST", Path: "/accountright/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/Purchase/Order/Service" },
      ],
    );
    await expect(allow("orders.create")).rejects.toMatchObject({
      code: "controls",
      message: expect.stringContaining("(2 of 2)"),
    });
  });

  it("lets a write through while under the allowance, and a cap of 0 allows none", async () => {
    world([control("orders.create", { DailyCap: 3 })], [{ Calls: 2, Method: "POST", Path: `/accountright/${CF}/Purchase/Order/Service` }]);
    await expect(allow("orders.create")).resolves.toBeUndefined();

    world([control("orders.create", { DailyCap: 0 })]);
    await expect(allow("orders.create")).rejects.toMatchObject({ code: "controls" });
  });

  it("counts updates across every record of the operation", async () => {
    world(
      [control("orders.update", { DailyCap: 2 })],
      [
        { Calls: 1, Method: "PUT", Path: `/accountright/${CF}/Purchase/Order/Service/11111111-2222-4333-8444-555555555555` },
        { Calls: 1, Method: "PUT", Path: `/accountright/${CF}/Purchase/Order/Service/22222222-2222-4333-8444-555555555555` },
      ],
    );
    await expect(allow("orders.update")).rejects.toMatchObject({ code: "controls" });
  });

  it("counts from the start of today in Darwin", async () => {
    world([control("orders.create")]);
    await allow("orders.create");
    const logQuery = db.executeQuery.mock.calls.find((c: unknown[]) => /FROM dbo\.MyobApiLog/.test(String(c[1])));
    expect(logQuery[2]).toEqual([expect.objectContaining({ name: "Since", value: new Date("2026-10-13T14:30:00Z") })]);
  });
});
