/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { recordDigestSent } from "./sentStore";

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return { ...actual, executeQuery: jest.fn() };
});
const db = require("../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;

beforeEach(() => db.executeQuery.mockReset());

describe("recordDigestSent", () => {
  it("stamps the Darwin date on that one person, as parameters", async () => {
    db.executeQuery.mockResolvedValue([]);
    await recordDigestSent(conn, 7, "2026-10-14");
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/^UPDATE dbo\.AppUsers SET DigestLastSentOn = CONVERT\(DATE, @SentOn, 23\) WHERE UserID = @UserID$/);
    expect(params).toEqual([
      { name: "SentOn", type: TYPES.NVarChar, value: "2026-10-14" },
      { name: "UserID", type: TYPES.Int, value: 7 },
    ]);
  });

  it("refuses a date that is not a calendar day, before it touches the database", async () => {
    for (const bad of ["", "14/10/2026", "2026-13-01", "2026-02-30", "2026-10-14; DROP TABLE x"]) {
      await expect(recordDigestSent(conn, 7, bad)).rejects.toThrow(/not a date/i);
    }
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("lets a database failure through, for the caller to report", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid column name 'DigestLastSentOn'"));
    await expect(recordDigestSent(conn, 7, "2026-10-14")).rejects.toThrow("DigestLastSentOn");
  });

  it("is the digest's only write, one statement that touches one column of one row", () => {
    const code = readFileSync(join(__dirname, "sentStore.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(code.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b(INSERT|DELETE|MERGE|TRUNCATE|DROP|ALTER)\b/);
  });
});
