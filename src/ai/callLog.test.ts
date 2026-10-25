/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TYPES } from "tedious";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

import { executeQuery } from "../db";
import { AI_CALL_INSERT_COLUMNS, COLUMN_LIMITS, countRecentAiCalls, insertAiCall, type AiLogEntry } from "./callLog";
import type { AiActor } from "./types";
import type { Connection } from "tedious";

const query = jest.mocked(executeQuery);
const connection = {} as Connection;
const migration = readFileSync(join(__dirname, "..", "..", "migrations", "170_ai_call_log.sql"), "utf8");

/** Column name -> its definition, from the column list inside the migration's N'...' literal. */
function migrationColumns(): Map<string, string> {
  const literal = migration.match(/DECLARE @cols NVARCHAR\(MAX\) = N'([\s\S]*?)';/)?.[1] ?? "";
  const found = new Map<string, string>();
  for (const line of literal.split("\n")) {
    const match = line.match(/^\s{4}([A-Za-z0-9]+)\s+(\S.*)$/);
    if (match && !["CONSTRAINT", "CHECK"].includes(match[1])) found.set(match[1], match[2]);
  }
  return found;
}

const ACTOR: AiActor = { email: "jo@randazzo.example", kind: "user", name: "Jo Bloggs", role: "facilities", userId: 41 };
const ENTRY: AiLogEntry = {
  actor: ACTOR,
  correlationId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766",
  errorCode: null,
  inputChars: 25,
  inputSha256: "a".repeat(64),
  latencyMs: 12,
  model: "mock",
  outcome: "ok",
  outputChars: 36,
  promptVersion: "echo_test@1",
  provider: "mock",
  purpose: "echo_test",
  recordId: null,
  recordType: null,
  redactionCount: 0,
};
const paramsOf = (call: number): Record<string, unknown> => Object.fromEntries((query.mock.calls[call][2] ?? []).map((param) => [param.name, param.value]));

beforeEach(() => {
  query.mockReset().mockResolvedValue([{ Id: "7" }]);
});

describe("the insert and migration 170 agree", () => {
  it("writes the columns the migration has, in its order, leaving the id and the clock to the database, and the two text columns empty", () => {
    const columns = [...migrationColumns().keys()];
    expect(columns.slice(0, 2)).toEqual(["Id", "CreatedAt"]);
    expect(columns.slice(-2)).toEqual(["InputText", "OutputText"]);
    expect([...AI_CALL_INSERT_COLUMNS]).toEqual(columns.slice(2, -2));
  });

  it("never writes InputText or OutputText: prompt and answer text is not stored in the append-only log (review M2)", async () => {
    expect([...AI_CALL_INSERT_COLUMNS]).not.toContain("InputText");
    expect([...AI_CALL_INSERT_COLUMNS]).not.toContain("OutputText");
    await insertAiCall(connection, ENTRY);
    expect(String(query.mock.calls[0][1])).not.toMatch(/InputText|OutputText/);
    expect((query.mock.calls[0][2] ?? []).map((param) => param.name)).not.toEqual(expect.arrayContaining(["InputText"]));
    expect(migrationColumns().get("InputText")).toMatch(/NULL,?$/);
    expect(migrationColumns().get("OutputText")).toMatch(/NULL,?$/);
  });

  it("binds one parameter per column, by the column's name", async () => {
    await insertAiCall(connection, ENTRY);
    const [, sql, params] = query.mock.calls[0];
    expect(params?.map((param) => param.name)).toEqual([...AI_CALL_INSERT_COLUMNS]);
    for (const column of AI_CALL_INSERT_COLUMNS) expect(sql).toContain(`@${column}`);
    expect(sql).toMatch(/^INSERT INTO dbo\.AiCallLog \(/);
    expect(sql).toContain("OUTPUT INSERTED.Id");
  });

  it("cuts each text value to its column's width, as the migration declares it", () => {
    const columns = migrationColumns();
    for (const [name, limit] of Object.entries(COLUMN_LIMITS)) {
      expect({ definition: columns.get(name)?.match(/^NVARCHAR\((\d+)\)/)?.[1], name }).toEqual({ definition: String(limit), name });
    }
  });

  it("makes the hash a CHAR(64) and the outcome and error code coherent, as the code writes them", () => {
    expect(migrationColumns().get("InputSha256")).toMatch(/^CHAR\(64\)\s+NOT NULL/);
    expect(migration).toMatch(/Outcome = ''ok'' AND ErrorCode IS NULL\) OR \(Outcome <> ''ok'' AND ErrorCode IS NOT NULL/);
  });
});

describe("insertAiCall", () => {
  it("passes the entry's values through with the right types", async () => {
    await insertAiCall(connection, { ...ENTRY, errorCode: "timeout", outcome: "failed", recordId: "42", recordType: "quote" });
    const params = Object.fromEntries((query.mock.calls[0][2] ?? []).map((param) => [param.name, param]));
    expect(params.ActorUserId).toMatchObject({ type: TYPES.Int, value: 41 });
    expect(params.CorrelationId).toMatchObject({ type: TYPES.UniqueIdentifier, value: ENTRY.correlationId });
    expect(params.InputSha256).toMatchObject({ type: TYPES.VarChar, value: "a".repeat(64) });
    expect(params.Outcome).toMatchObject({ value: "failed" });
    expect(params.ErrorCode).toMatchObject({ value: "timeout" });
    expect(params.RecordType).toMatchObject({ value: "quote" });
    expect(params.RecordId).toMatchObject({ value: "42" });
  });

  it("writes nulls for what a system actor or a refused call does not have", async () => {
    await insertAiCall(connection, {
      ...ENTRY,
      actor: { email: null, kind: "system", name: "digestTimer", role: null, userId: null },
      latencyMs: null,
      model: null,
      outputChars: null,
    });
    expect(paramsOf(0)).toMatchObject({ ActorEmail: null, ActorKind: "system", ActorRole: null, ActorUserId: null, LatencyMs: null, Model: null, OutputChars: null });
  });

  it("clips over-long values so the insert cannot fail on width", async () => {
    await insertAiCall(connection, {
      ...ENTRY,
      actor: { ...ACTOR, email: `${"e".repeat(400)}@x.co`, name: "n".repeat(300) },
      purpose: "p".repeat(100),
      recordId: "r".repeat(100),
    });
    const params = paramsOf(0);
    expect(String(params.ActorEmail)).toHaveLength(COLUMN_LIMITS.ActorEmail);
    expect(String(params.ActorName)).toHaveLength(COLUMN_LIMITS.ActorName);
    expect(String(params.Purpose)).toHaveLength(COLUMN_LIMITS.Purpose);
    expect(String(params.RecordId)).toHaveLength(COLUMN_LIMITS.RecordId);
  });

  it("returns the new row's id, whether the driver sends a number or a string, and null when it sends none", async () => {
    query.mockResolvedValueOnce([{ Id: 12 }]);
    expect(await insertAiCall(connection, ENTRY)).toBe(12);
    query.mockResolvedValueOnce([{ Id: "9007" }]);
    expect(await insertAiCall(connection, ENTRY)).toBe(9007);
    query.mockResolvedValueOnce([]);
    expect(await insertAiCall(connection, ENTRY)).toBeNull();
  });

  it("lets a database failure through for the gateway to decide on", async () => {
    query.mockRejectedValueOnce(new Error("Invalid object name 'dbo.AiCallLog'."));
    await expect(insertAiCall(connection, ENTRY)).rejects.toThrow("Invalid object name");
  });
});

describe("countRecentAiCalls", () => {
  it("counts every call this person made in the last 60 seconds, whatever its outcome, by their id", async () => {
    query.mockResolvedValueOnce([{ Calls: 3 }]);
    expect(await countRecentAiCalls(connection, ACTOR)).toBe(3);
    const sql = String(query.mock.calls[0][1]);
    expect(sql).toContain("DATEADD(SECOND, -60, SYSUTCDATETIME())");
    expect(sql).not.toMatch(/Outcome/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/i);
    expect(paramsOf(0)).toEqual({ Email: "jo@randazzo.example", Kind: "user", Name: "Jo Bloggs", UserId: 41 });
  });

  it("counts a person not in AppUsers by email, and a system actor by name", async () => {
    query.mockResolvedValue([{ Calls: 0 }]);
    await countRecentAiCalls(connection, { ...ACTOR, userId: null });
    expect(paramsOf(0)).toMatchObject({ Email: "jo@randazzo.example", UserId: null });
    await countRecentAiCalls(connection, { email: null, kind: "system", name: "digestTimer", role: null, userId: null });
    expect(paramsOf(1)).toMatchObject({ Email: null, Kind: "system", Name: "digestTimer", UserId: null });
  });

  it("reads no rows as no calls", async () => {
    query.mockResolvedValueOnce([]);
    expect(await countRecentAiCalls(connection, ACTOR)).toBe(0);
  });
});
