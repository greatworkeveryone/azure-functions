/// <reference types="jest" />

jest.mock("./db", () => ({ executeQuery: jest.fn() }));
jest.mock("./ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

import { changeFileSettings, recordDiscoveredFiles, registerCompanyFile } from "./myob-company-files-admin";
import type { LedgerActor } from "./ledger";

const { executeQuery } = require("./db") as { executeQuery: jest.Mock };
const { record } = require("./ledger") as { record: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const JOHANNE: LedgerActor = { kind: "user", name: "Johanne", role: "cfo", userId: 12 };
const V1 = Buffer.from("0000000000000001", "hex");
const V2 = Buffer.from("0000000000000002", "hex");
const tx = {} as never;

const fileRow = (over: Record<string, unknown> = {}) => ({
  CompanyFileId: CF, IsDemonstration: false, Mode: "off", Name: "Demo Pty Ltd", Note: null, RegisteredAt: new Date(),
  RegisteredBy: "Johanne", RowVersion: V1, UpdatedAt: new Date(), UpdatedBy: null, Uri: null, ...over,
});

function world(files: ReturnType<typeof fileRow>[]) {
  const current = files.map((f) => ({ ...f }));
  executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    if (/INSERT INTO dbo\.MyobCompanyFiles/.test(sql)) {
      const row = fileRow({ CompanyFileId: p.CompanyFileId, DiscoveredAt: p.Discovered ? new Date() : null, Name: p.Name ?? null });
      current.push(row);
      return [row];
    }
    if (/UPDATE dbo\.MyobCompanyFiles/.test(sql) && /DiscoveredAt = SYSUTCDATETIME\(\)/.test(sql)) return [];
    if (/UPDATE dbo\.MyobCompanyFiles/.test(sql)) {
      const target = current.find((f) => f.CompanyFileId === p.CompanyFileId && Buffer.compare(f.RowVersion, p.RowVersion as Buffer) === 0);
      if (!target) return [];
      Object.assign(target, { IsDemonstration: p.IsDemonstration, Mode: p.Mode, Note: p.Note, RowVersion: V2, UpdatedBy: p.UpdatedBy });
      return [target];
    }
    if (/FROM dbo\.MyobCompanyFiles/.test(sql)) return current.filter((f) => !p.CompanyFileId || f.CompanyFileId === p.CompanyFileId);
    return [];
  });
  return current;
}

beforeEach(() => jest.clearAllMocks());

describe("registerCompanyFile", () => {
  it("adds the file switched off and ledgers it", async () => {
    world([]);

    const row = await registerCompanyFile(tx, JOHANNE, { companyFileId: CF, name: "Demo Pty Ltd", note: "MYOB's sample file" });

    expect(row).toMatchObject({ companyFileId: CF, mode: "off" });
    expect(record).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "myob.control_change",
      after: { mode: "off", name: "Demo Pty Ltd" },
      reason: "MYOB's sample file",
      ruleApplied: "register",
      subject: { id: `${CF}:entity`, type: "myob_control" },
    }));
  });

  it("409s for a file already registered", async () => {
    world([fileRow()]);
    await expect(registerCompanyFile(tx, JOHANNE, { companyFileId: CF, name: null, note: "x" })).rejects.toMatchObject({ status: 409 });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("changeFileSettings", () => {
  const change = (over: Record<string, unknown> = {}) =>
    changeFileSettings(tx, JOHANNE, { changes: { mode: "read" }, companyFileId: CF, expectedRowVersion: V1.toString("base64"), note: "Reads for the mirror", ...over });

  it("changes the mode and ledgers before, after and the note", async () => {
    world([fileRow()]);

    const result = await change();

    expect(result).toMatchObject({ changed: true, row: { mode: "read", rowVersion: V2.toString("base64") } });
    expect(record).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "myob.control_change",
      after: { isDemonstration: false, mode: "read" },
      before: { isDemonstration: false, mode: "off" },
      reason: "Reads for the mirror",
      ruleApplied: "mode",
      subject: { id: `${CF}:entity`, type: "myob_control" },
    }));
  });

  it("marks the demonstration file", async () => {
    world([fileRow()]);
    await expect(change({ changes: { isDemonstration: true } })).resolves.toMatchObject({ row: { isDemonstration: true } });
  });

  it("409s on a stale or missing version, and 404s an unknown file, writing nothing", async () => {
    world([fileRow()]);
    await expect(change({ expectedRowVersion: V2.toString("base64") })).rejects.toMatchObject({ status: 409 });
    await expect(change({ expectedRowVersion: null })).rejects.toMatchObject({ status: 409 });
    await expect(change({ companyFileId: OTHER })).rejects.toMatchObject({ status: 404 });
    expect(record).not.toHaveBeenCalled();
  });

  it("changes nothing, and ledgers nothing, when the values are already set", async () => {
    world([fileRow({ Mode: "read" })]);
    await expect(change()).resolves.toMatchObject({ changed: false });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("recordDiscoveredFiles", () => {
  it("registers files MYOB lists that Floorplan doesn't know, switched off, and only touches the date on known ones", async () => {
    world([fileRow()]);

    const result = await recordDiscoveredFiles(tx, JOHANNE, [
      { Id: CF.toUpperCase(), Name: "Demo Pty Ltd" },
      { Id: OTHER, Name: "RP (NT) Pty Ltd", Uri: "https://api.myob.com/accountright/x" },
      { Id: "not-a-guid", Name: "junk" },
    ]);

    expect(result).toEqual({ added: [OTHER], seen: 2 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toMatchObject({ after: { mode: "off", name: "RP (NT) Pty Ltd" }, ruleApplied: "discover" });
  });
});
