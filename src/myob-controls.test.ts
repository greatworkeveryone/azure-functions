/// <reference types="jest" />

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));

import { assertMyobControlsPresent } from "./myob-controls";

const db = require("./db") as Record<string, jest.Mock>;
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const original = process.env.MYOB_COMPANY_FILE_ID;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MYOB_COMPANY_FILE_ID;
});

afterAll(() => {
  if (original === undefined) delete process.env.MYOB_COMPANY_FILE_ID;
  else process.env.MYOB_COMPANY_FILE_ID = original;
});

describe("assertMyobControlsPresent (the client's boot guard)", () => {
  it("passes when MyobControls has rows for the file", async () => {
    db.executeQuery.mockResolvedValue([{ Present: 1 }]);

    await expect(assertMyobControlsPresent(CF)).resolves.toBeUndefined();
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "CompanyFileId", value: CF })]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("refuses when the file has no controls", async () => {
    db.executeQuery.mockResolvedValue([]);

    await expect(assertMyobControlsPresent(CF)).rejects.toMatchObject({ code: "controls" });
  });

  it("refuses, failing closed, when the controls table can't be read", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid object name 'dbo.MyobControls'"));

    await expect(assertMyobControlsPresent(CF)).rejects.toMatchObject({ code: "controls" });
  });

  it("uses the configured file for a call that names none (the file list), and refuses with neither", async () => {
    await expect(assertMyobControlsPresent(null)).rejects.toMatchObject({ code: "controls" });
    expect(db.executeQuery).not.toHaveBeenCalled();

    process.env.MYOB_COMPANY_FILE_ID = CF.toUpperCase();
    db.executeQuery.mockResolvedValue([{ Present: 1 }]);
    await expect(assertMyobControlsPresent(null)).resolves.toBeUndefined();
    expect(db.executeQuery.mock.calls[0][2][0].value).toBe(CF);
  });
});
