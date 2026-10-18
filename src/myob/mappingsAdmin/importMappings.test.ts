/// <reference types="jest" />

jest.mock("../../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./mappingsStore", () => ({ loadRefs: jest.fn(), writePlan: jest.fn().mockResolvedValue(undefined) }));

import { importMappings, type ImportInput } from "./importMappings";
import type { MappingRefs } from "./mappingKinds";

const { record } = require("../../ledger") as { record: jest.Mock };
const store = require("./mappingsStore") as Record<string, jest.Mock>;

const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const SUP = "44444444-2222-4333-8444-555555555555";
const SUP2 = "55555555-2222-4333-8444-555555555555";
const JOHANNE = { kind: "user" as const, name: "Johanne", role: "cfo", userId: 12 };
const HEAD = "company_file_id,contractor_id,supplier_uid,supplier_name\n";
const refs = (existing = new Map()): MappingRefs => ({
  buildings: new Map(),
  contractors: new Map([[12, { abn: null, name: "ACME Air" }], [13, { abn: null, name: "Bob" }]]),
  existing,
  files: new Map([[DEMO, "Demo Pty Ltd"]]),
});
const input = (over: Partial<ImportInput> = {}): ImportInput => ({ csv: `${HEAD}${DEMO},12,${SUP},ACME Air Pty Ltd\n`, kind: "suppliers", mode: "preview", note: null, previewHash: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  store.loadRefs.mockResolvedValue(refs());
});

const OTHER = "22222222-2222-4333-8444-555555555555";
const twoFiles = (existing = new Map()): MappingRefs => ({ ...refs(existing), files: new Map([[DEMO, "Demo Pty Ltd"], [OTHER, "Other Pty Ltd"]]) });

describe("importMappings", () => {
  it.each([
    ["one supplier UID changed", `${HEAD}${DEMO},12,${SUP2},ACME Air Pty Ltd\n`],
    ["the company file changed", `${HEAD}${OTHER},12,${SUP},ACME Air Pty Ltd\n`],
  ])("refuses to apply a different file from the one previewed (%s): 409, nothing written", async (_label, otherCsv) => {
    store.loadRefs.mockResolvedValue(twoFiles());
    const preview = await importMappings({} as never, JOHANNE, input());
    await expect(importMappings({} as never, JOHANNE, input({ csv: otherCsv, mode: "apply", previewHash: preview.plan.hash }))).rejects.toMatchObject({ status: 409 });
    expect(store.writePlan).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("ledgers one row per company file, each with its own counts and changes before → after", async () => {
    const existing = new Map([[`${OTHER}|13`, { rowVersion: "v1", values: { abn: null, supplierName: "Bob", supplierUid: SUP, taxCode: null, taxCodeUid: null } }]]);
    store.loadRefs.mockResolvedValue(twoFiles(existing));
    const csv = `${HEAD}${DEMO},12,${SUP},ACME Air Pty Ltd\n${DEMO},99,${SUP},Nobody\n${OTHER},13,${SUP2},Bob Pty Ltd\n${OTHER},12,${SUP},ACME\n`;
    const preview = await importMappings({} as never, JOHANNE, input({ csv }));
    await importMappings({} as never, JOHANNE, input({ csv, mode: "apply", note: "Both files", previewHash: preview.plan.hash }));
    expect(record).toHaveBeenCalledTimes(2);
    const byFile = Object.fromEntries(record.mock.calls.map((call: unknown[]) => {
      const entry = call[1] as { after: Record<string, unknown>; subject: { id: string } };
      return [entry.subject.id, entry.after];
    }));
    expect(byFile[`${DEMO}:mappings`]).toMatchObject({ added: 1, changed: 0, changes: [], skipped: 1 });
    expect(byFile[`${OTHER}:mappings`]).toMatchObject({
      added: 1, changed: 1, changes: [{ after: expect.objectContaining({ supplierUid: SUP2 }), before: expect.objectContaining({ supplierUid: SUP }), key: `${OTHER}|13` }], skipped: 0,
    });
  });

  it("previews without locking, writing or ledgering", async () => {
    const result = await importMappings({} as never, JOHANNE, input());
    expect(result).toMatchObject({ applied: false, plan: { counts: { add: 1 } } });
    expect(store.loadRefs).toHaveBeenCalledWith(expect.anything(), "suppliers", false);
    expect(store.writePlan).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("applies exactly the previewed plan under lock and ledgers the import with counts", async () => {
    const preview = await importMappings({} as never, JOHANNE, input());
    const result = await importMappings({} as never, JOHANNE, input({ mode: "apply", previewHash: preview.plan.hash }));
    expect(result.applied).toBe(true);
    expect(store.loadRefs).toHaveBeenLastCalledWith(expect.anything(), "suppliers", true);
    expect(store.writePlan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hash: preview.plan.hash }), "Johanne", null);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "myob.control_change",
      after: expect.objectContaining({ added: 1, changed: 0, kind: "suppliers" }),
      reason: "Imported 1 new supplier mappings from a CSV",
      ruleApplied: "import.suppliers",
      subject: { id: `${DEMO}:mappings`, type: "myob_control" },
    }));
  });

  it("refuses an apply when anything moved since the preview (409), writing nothing", async () => {
    const preview = await importMappings({} as never, JOHANNE, input());
    store.loadRefs.mockResolvedValue(refs(new Map([[`${DEMO}|12`, { rowVersion: "v2", values: { abn: null, supplierName: "Other", supplierUid: SUP2, taxCode: null, taxCodeUid: null } }]])));
    await expect(importMappings({} as never, JOHANNE, input({ mode: "apply", previewHash: preview.plan.hash }))).rejects.toMatchObject({ status: 409 });
    expect(store.writePlan).not.toHaveBeenCalled();
  });

  it("needs her note when an import changes an existing mapping, and ledgers the change before → after", async () => {
    store.loadRefs.mockResolvedValue(refs(new Map([[`${DEMO}|12`, { rowVersion: "v1", values: { abn: null, supplierName: "ACME Air", supplierUid: SUP2, taxCode: null, taxCodeUid: null } }]])));
    const preview = await importMappings({} as never, JOHANNE, input());
    expect(preview.plan.counts.change).toBe(1);
    await expect(importMappings({} as never, JOHANNE, input({ mode: "apply", previewHash: preview.plan.hash }))).rejects.toMatchObject({ status: 400 });
    await importMappings({} as never, JOHANNE, input({ mode: "apply", note: "New supplier card after the merger", previewHash: preview.plan.hash }));
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      after: expect.objectContaining({ changes: [expect.objectContaining({ after: expect.objectContaining({ supplierUid: SUP }), before: expect.objectContaining({ supplierUid: SUP2 }) })] }),
      reason: "New supplier card after the merger",
    }));
  });

  it("turns a bad file into a plain 400", async () => {
    await expect(importMappings({} as never, JOHANNE, input({ csv: "nothing,useful\n1,2\n" }))).rejects.toMatchObject({ message: expect.stringContaining("needs the columns"), status: 400 });
    await expect(importMappings({} as never, JOHANNE, input({ csv: 'a,b\n"open\n' }))).rejects.toMatchObject({ status: 400 });
  });

  it("writes and ledgers nothing when every row is skipped or already mapped", async () => {
    const csv = `${HEAD}not-a-file,12,${SUP},ACME\n`;
    const preview = await importMappings({} as never, JOHANNE, input({ csv }));
    await expect(importMappings({} as never, JOHANNE, input({ csv, mode: "apply", previewHash: preview.plan.hash }))).resolves.toMatchObject({ applied: true });
    expect(store.writePlan).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
