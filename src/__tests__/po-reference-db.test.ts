/// <reference types="jest" />
import type { Connection } from "tedious";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const { executeQuery } = require("../db") as { executeQuery: jest.Mock };
const { resolvePoNumber } = require("../po-reference-db") as typeof import("../po-reference-db");

const connection = {} as Connection;
// 05:30 on 13 Oct in Darwin, still the 12th in UTC.
const NOW = new Date("2026-10-12T20:00:00Z");
const FALLBACK = "261012-PO-42-ACM-7";

interface JobRow {
  Category?: string | null;
  JobType?: string | null;
  SubType?: string | null;
  ReferenceCode?: string | null;
}

function arrange(job: JobRow | null, existing: string[] = []) {
  executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM Jobs j/.test(sql)) return job ? [{ Category: null, JobType: null, SubType: null, ReferenceCode: null, ...job }] : [];
    if (/FROM PurchaseOrders WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return existing.map((PONumber) => ({ PONumber }));
    throw new Error(`unexpected query: ${sql}`);
  });
}

const resolve = (extra: Partial<Parameters<typeof resolvePoNumber>[1]> = {}) =>
  resolvePoNumber(connection, { jobId: 42, fallbackPoNumber: FALLBACK, now: NOW, ...extra });

beforeEach(() => executeQuery.mockReset());

describe("resolvePoNumber", () => {
  it("builds building + charge + Darwin date, deriving the charge code from the job", async () => {
    arrange({ Category: "Common Areas", JobType: "Electrical", ReferenceCode: "66S" });
    await expect(resolve()).resolves.toEqual({ poNumber: "66Se261013", chargeCode: "e", warning: null });
  });

  it("uses the job category when it names a discipline", async () => {
    arrange({ Category: "Lifts", JobType: "Plumbing", ReferenceCode: "9C" });
    expect((await resolve()).poNumber).toBe("9Clm261013");
  });

  it("falls back to m for a plain facilities job", async () => {
    arrange({ Category: "Tenancy Works", ReferenceCode: "McM" });
    expect(await resolve()).toMatchObject({ poNumber: "McMm261013", chargeCode: "m" });
  });

  it("appends a suffix when the number is already taken", async () => {
    arrange({ JobType: "Electrical", ReferenceCode: "66S" }, ["66Se261013"]);
    expect((await resolve()).poNumber).toBe("66Se261013b");
    arrange({ JobType: "Electrical", ReferenceCode: "66S" }, ["66Se261013", "66Se261013b"]);
    expect((await resolve()).poNumber).toBe("66Se261013c");
  });

  it("reads existing numbers under UPDLOCK/HOLDLOCK with a base-prefix LIKE", async () => {
    arrange({ JobType: "Electrical", ReferenceCode: "66S" });
    await resolve();
    const call = executeQuery.mock.calls.find(([, sql]: [unknown, string]) => /UPDLOCK, HOLDLOCK/.test(sql));
    expect(call).toBeDefined();
    expect(call![1]).toMatch(/WHERE PONumber LIKE @Prefix/);
    expect(call![2]).toEqual([expect.objectContaining({ name: "Prefix", value: "66Se261013%" })]);
  });

  describe("body charge code", () => {
    it("wins when it is a listed code", async () => {
      arrange({ JobType: "Electrical", ReferenceCode: "66S" });
      expect(await resolve({ requestedChargeCode: "gm" })).toMatchObject({ poNumber: "66Sgm261013", chargeCode: "gm" });
    });

    it("is trimmed", async () => {
      arrange({ ReferenceCode: "66S" });
      expect((await resolve({ requestedChargeCode: " ins " })).poNumber).toBe("66Sins261013");
    });

    it("accepts the case-sensitive legacy SECr when asked for explicitly", async () => {
      arrange({ ReferenceCode: "66S" });
      expect((await resolve({ requestedChargeCode: "SECr" })).poNumber).toBe("66SSECr261013");
    });

    it.each([["GM"], ["secr"], ["zz"], [""], [42], [null], [undefined], [{ toString: "x" }]])(
      "is ignored when invalid (%j)",
      async (requested) => {
        arrange({ JobType: "Lifts", ReferenceCode: "66S" });
        expect(await resolve({ requestedChargeCode: requested })).toMatchObject({
          poNumber: "66Slm261013",
          chargeCode: "lm",
        });
      },
    );
  });

  describe("falls back to the legacy number without blocking", () => {
    it("when the building has no ReferenceCode", async () => {
      arrange({ JobType: "Electrical", ReferenceCode: null });
      const result = await resolve();
      expect(result.poNumber).toBe(FALLBACK);
      expect(result.chargeCode).toBe("e");
      expect(result.warning).toMatch(/no ReferenceCode/);
      expect(executeQuery).toHaveBeenCalledTimes(1);
    });

    it("when the job has no building row at all", async () => {
      arrange(null);
      const result = await resolve();
      expect(result.poNumber).toBe(FALLBACK);
      expect(result.chargeCode).toBe("m");
      expect(result.warning).toMatch(/Job 42/);
    });

    it("when the reference would exceed MYOB's 13 characters", async () => {
      arrange({ ReferenceCode: "ABCD" });
      const result = await resolve({ requestedChargeCode: "SECr" });
      expect(result.poNumber).toBe(FALLBACK);
      expect(result.warning).toMatch(/14 characters|MYOB allows 13/);
    });

    it("when the stored building code is not alphanumeric", async () => {
      arrange({ ReferenceCode: "6-6" });
      const result = await resolve();
      expect(result.poNumber).toBe(FALLBACK);
      expect(result.warning).toMatch(/Invalid building code/);
      expect(executeQuery).toHaveBeenCalledTimes(1);
    });

    it("when all 25 suffixes are taken", async () => {
      const base = "66Sm261013";
      arrange({ ReferenceCode: "66S" }, [base, ..."bcdefghijklmnopqrstuvwxyz"].map((x, i) => (i === 0 ? x : `${base}${x}`)));
      const result = await resolve();
      expect(result.poNumber).toBe(FALLBACK);
      expect(result.warning).toMatch(/No free suffix/);
    });
  });

  it("lets a database error abort rather than degrading to the legacy number", async () => {
    executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM Jobs j/.test(sql)) return [{ ReferenceCode: "66S" }];
      throw new Error("deadlock victim");
    });
    await expect(resolve()).rejects.toThrow("deadlock victim");
  });
});
