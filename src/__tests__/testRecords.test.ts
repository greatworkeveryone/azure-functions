/// <reference types="jest" />
// Decision 4: admin acts on money only for test records. The flag column
// (Jobs.IsTest) arrives with migration 127 (D9); until it exists every job is
// real, and the loader must not query a column that isn't there.

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };

function load(): { isTestJob: (connection: unknown, jobId: number) => Promise<boolean> } {
  let mod: { isTestJob: (connection: unknown, jobId: number) => Promise<boolean> } | undefined;
  jest.isolateModules(() => {
    mod = require("../testRecords");
  });
  return mod as { isTestJob: (connection: unknown, jobId: number) => Promise<boolean> };
}

function answer(columnLength: number | null, isTest?: unknown): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/.test(sql)) return [{ Len: columnLength }];
    if (/SELECT IsTest FROM Jobs WHERE JobID = @JobID/.test(sql)) return isTest === undefined ? [] : [{ IsTest: isTest }];
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

beforeEach(() => db.executeQuery.mockReset());

describe("isTestJob", () => {
  it("treats every job as real while the IsTest column does not exist, and never reads it", async () => {
    answer(null);
    await expect(load().isTestJob({}, 9)).resolves.toBe(false);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("reads the job's flag once the column exists", async () => {
    answer(1, true);
    const { isTestJob } = load();
    await expect(isTestJob({}, 9)).resolves.toBe(true);
    const flagRead = db.executeQuery.mock.calls.find((c: unknown[]) => /SELECT IsTest/.test(String(c[1])));
    expect(flagRead?.[2]).toEqual([expect.objectContaining({ name: "JobID", value: 9 })]);
  });

  it("is false for a real job and for a job that doesn't exist", async () => {
    answer(1, false);
    const { isTestJob } = load();
    await expect(isTestJob({}, 9)).resolves.toBe(false);
    answer(1);
    await expect(isTestJob({}, 10)).resolves.toBe(false);
  });

  it("checks for the column once it has seen it, not on every call", async () => {
    answer(1, 1);
    const { isTestJob } = load();
    await isTestJob({}, 9);
    await isTestJob({}, 9);
    const probes = db.executeQuery.mock.calls.filter((c: unknown[]) => /COL_LENGTH/.test(String(c[1])));
    expect(probes).toHaveLength(1);
  });
});
