/// <reference types="jest" />
import type { Connection } from "tedious";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const { executeQuery } = require("../db") as { executeQuery: jest.Mock };
const { matchJobId } = require("./job-match") as typeof import("./job-match");
const { poNumbersFromText } = require("./job-ref") as typeof import("./job-ref");

const connection = {} as Connection;

beforeEach(() => {
  executeQuery.mockReset();
  executeQuery.mockResolvedValue([]);
});

describe("poNumbersFromText", () => {
  it("reads subject then body, without repeats", () => {
    expect(poNumbersFromText("Re: Purchase Order 66Sm261013 — Leaking tap", "PO 9Ce261013b and PO 66Sm261013")).toEqual([
      "66Sm261013",
      "9Ce261013b",
    ]);
  });

  it("ignores numbers that only appear in quoted history", () => {
    const body = "Thanks, done.\n\nOn Mon, 12 Oct 2026, Ops wrote:\n> PO 66Sm261013 attached";
    expect(poNumbersFromText("Re: your email", body)).toEqual([]);
  });

  it("ignores legacy document numbers, which carry their own job id", () => {
    expect(poNumbersFromText("Purchase Order 260419-PO-42-ACM-7", null)).toEqual([]);
  });

  it("is empty for null input", () => {
    expect(poNumbersFromText(null, null)).toEqual([]);
  });
});

describe("matchJobId", () => {
  it("uses the job id in the text and never touches the database", async () => {
    expect(await matchJobId(connection, "Job #42 — PO 66Sm261013", null)).toBe(42);
    expect(await matchJobId(connection, "Purchase Order 260419-PO-7-ACM-1", null)).toBe(7);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("skips the database when there is nothing to look up", async () => {
    expect(await matchJobId(connection, "Hello", "Nothing to see")).toBeNull();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("matches a reply to a new-format PO through PurchaseOrders", async () => {
    executeQuery.mockResolvedValue([{ JobID: 123 }]);

    const id = await matchJobId(connection, "Re: Purchase Order 66Sm261013 — Leaking tap L2 kitchen", null);

    expect(id).toBe(123);
    expect(executeQuery).toHaveBeenCalledTimes(1);
    const [, sql, params] = executeQuery.mock.calls[0];
    expect(sql).toMatch(/FROM PurchaseOrders WHERE PONumber = @PONumber/);
    expect(params).toEqual([expect.objectContaining({ name: "PONumber", value: "66Sm261013" })]);
  });

  it("finds the number in the body when the subject has none", async () => {
    executeQuery.mockResolvedValue([{ JobID: 9 }]);
    expect(await matchJobId(connection, "Invoice", "<p>For PO 9Ce261013b</p>")).toBe(9);
  });

  it("returns null when the PO is unknown", async () => {
    expect(await matchJobId(connection, "PO 66Sm261013", null)).toBeNull();
  });

  it("returns null when the number belongs to more than one job", async () => {
    executeQuery.mockResolvedValue([{ JobID: 1 }, { JobID: 2 }]);
    expect(await matchJobId(connection, "PO 66Sm261013", null)).toBeNull();
  });

  it("tries the next number when the first is unknown", async () => {
    executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ JobID: 5 }]);
    expect(await matchJobId(connection, "PO 66Sm261013 / PO 9Ce261013b", null)).toBe(5);
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it("caps the number of lookups", async () => {
    const refs = ["66Sm261001", "66Sm261002", "66Sm261003", "66Sm261004", "66Sm261005", "66Sm261006", "66Sm261007"];
    await matchJobId(connection, refs.map((r) => `PO ${r}`).join(" "), null);
    expect(executeQuery).toHaveBeenCalledTimes(5);
  });

  it("lets a database error propagate", async () => {
    executeQuery.mockRejectedValue(new Error("boom"));
    await expect(matchJobId(connection, "PO 66Sm261013", null)).rejects.toThrow("boom");
  });
});
