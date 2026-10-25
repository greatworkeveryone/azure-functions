/// <reference types="jest" />
import { TYPES } from "tedious";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

import { executeQuery } from "../db";
import { darwinDayStartUtc, darwinNextDayStartUtc } from "../ledger/darwinTime";
import { parseAiCallQuery, queryAiCalls, toAiCallDto, type AiCallFilters } from "./callQuery";
import type { Connection } from "tedious";

const query = jest.mocked(executeQuery);
const connection = {} as Connection;
const parse = (qs: string) => parseAiCallQuery(new URLSearchParams(qs));
const NO_FILTERS: AiCallFilters = { actor: null, from: null, outcome: null, purpose: null, to: null };
const PAGE = { active: true, limit: 50, offset: 0, page: 1, pageSize: 50 } as const;

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
});

describe("parseAiCallQuery", () => {
  it("reads no filters and the first page of 50 from an empty query", () => {
    expect(parse("")).toEqual({ filters: NO_FILTERS, page: { active: true, limit: 50, offset: 0, page: 1, pageSize: 50 } });
  });

  it("reads every filter", () => {
    const result = parse("purpose=echo_test&outcome=refused&actor=%20Jo%20&from=2026-10-01&to=2026-10-23&page=3&pageSize=25");
    expect(result).toEqual({
      filters: { actor: "Jo", from: { day: 1, month: 10, year: 2026 }, outcome: "refused", purpose: "echo_test", to: { day: 23, month: 10, year: 2026 } },
      page: { active: true, limit: 25, offset: 50, page: 3, pageSize: 25 },
    });
  });

  it("treats blank filters as unset", () => {
    expect(parse("purpose=&outcome=&actor=%20&from=&to=")).toMatchObject({ filters: NO_FILTERS });
  });

  it("clamps the page size to 200 like every other list", () => {
    expect(parse("pageSize=5000")).toMatchObject({ page: { pageSize: 200 } });
  });

  it.each([
    ["a purpose with capitals", "purpose=Echo_Test"],
    ["a purpose with a quote", "purpose=echo'test"],
    ["a purpose that is too long", `purpose=a${"b".repeat(64)}`],
    ["an outcome that is not one", "outcome=success"],
    ["an outcome in capitals", "outcome=OK"],
    ["a long actor", `actor=${"a".repeat(101)}`],
    ["a date that is not a date", "from=2026-02-30"],
    ["a date in the wrong format", "from=23/10/2026"],
    ["a to before the from", "from=2026-10-23&to=2026-10-22"],
    ["an enormous page", "page=1000000000"],
  ])("refuses %s", (_label, qs) => {
    expect(parse(qs)).toEqual({ error: expect.any(String) });
  });

  it("allows a single day: from equal to to", () => {
    expect(parse("from=2026-10-23&to=2026-10-23")).toMatchObject({ filters: { from: { day: 23 }, to: { day: 23 } } });
  });
});

describe("queryAiCalls", () => {
  it("reads a page newest first, with the total, through bound parameters", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Total: "123" }]);
    const result = await queryAiCalls(connection, NO_FILTERS, { ...PAGE, offset: 100, page: 3 });

    expect(result).toEqual({ items: [], total: 123 });
    const [, pageSql] = query.mock.calls[0];
    expect(pageSql).toMatch(/FROM dbo\.AiCallLog\s+ORDER BY Id DESC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY$/);
    expect(query.mock.calls[1][1]).toBe("SELECT COUNT_BIG(*) AS Total FROM dbo.AiCallLog ");
  });

  it("never selects the hash, the text columns or the actor's id", async () => {
    await queryAiCalls(connection, NO_FILTERS, PAGE);
    const select = String(query.mock.calls[0][1]);
    for (const column of ["InputText", "OutputText", "InputSha256", "ActorUserId"]) expect(select).not.toContain(column);
    expect(select).not.toMatch(/SELECT\s+\*/i);
    expect(select).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });

  it("filters by every field with a bound parameter, and uses the same filter for the total", async () => {
    const filters: AiCallFilters = {
      actor: "50%_[x]\\",
      from: { day: 1, month: 10, year: 2026 },
      outcome: "failed",
      purpose: "echo_test",
      to: { day: 23, month: 10, year: 2026 },
    };
    await queryAiCalls(connection, filters, PAGE);
    const [, sql, params] = query.mock.calls[0];
    expect(sql).toContain("WHERE Purpose = @Purpose AND Outcome = @Outcome AND (ActorEmail LIKE @Actor ESCAPE '\\' OR ActorName LIKE @Actor ESCAPE '\\') AND CreatedAt >= @From AND CreatedAt < @To");
    expect(sql).not.toContain("echo_test");
    expect(Object.fromEntries((params ?? []).map((param) => [param.name, param.value]))).toEqual({
      Actor: "%50\\%\\_\\[x]\\\\%",
      From: darwinDayStartUtc(filters.from!),
      Outcome: "failed",
      Purpose: "echo_test",
      To: darwinNextDayStartUtc(filters.to!),
    });
    expect((params ?? []).find((param) => param.name === "From")?.type).toBe(TYPES.DateTime2);
    expect(query.mock.calls[1][1]).toContain("WHERE Purpose = @Purpose AND Outcome = @Outcome");
    expect(query.mock.calls[1][2]).toEqual(params);
  });

  it("reads no total as zero", async () => {
    expect((await queryAiCalls(connection, NO_FILTERS, PAGE)).total).toBe(0);
  });

  it("includes the whole of the last day: the upper bound is the start of the next Darwin day", () => {
    const to = { day: 23, month: 10, year: 2026 };
    expect(darwinNextDayStartUtc(to).getTime() - darwinDayStartUtc(to).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("toAiCallDto", () => {
  const row = {
    ActorEmail: "jo@randazzo.example",
    ActorName: "Jo Bloggs",
    ActorRole: "facilities",
    CorrelationId: "0F9E8D7C-6B5A-4F3E-9D2C-1B0A99887766",
    CreatedAt: new Date("2026-10-23T01:02:03.456Z"),
    ErrorCode: null,
    Id: "101",
    InputChars: 25,
    LatencyMs: 12,
    Model: "mock",
    Outcome: "ok",
    OutputChars: 36,
    PromptVersion: "echo_test@1",
    Provider: "mock",
    Purpose: "echo_test",
    RecordId: null,
    RecordType: "health_check",
    RedactionCount: 0,
  };

  it("shapes a row for the wire: ISO time, numbers as numbers, the correlation id in lower case", () => {
    expect(toAiCallDto(row)).toEqual({
      actorEmail: "jo@randazzo.example",
      actorName: "Jo Bloggs",
      actorRole: "facilities",
      correlationId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766",
      createdAt: "2026-10-23T01:02:03.456Z",
      errorCode: null,
      id: 101,
      inputChars: 25,
      latencyMs: 12,
      model: "mock",
      outcome: "ok",
      outputChars: 36,
      promptVersion: "echo_test@1",
      provider: "mock",
      purpose: "echo_test",
      recordId: null,
      recordType: "health_check",
      redactionCount: 0,
    });
  });

  it("keeps nulls null, and has no field for stored text or a hash", () => {
    const dto = toAiCallDto({ ...row, ActorEmail: null, CorrelationId: null, LatencyMs: null, Model: null, OutputChars: null, InputText: "secret", OutputText: "secret", InputSha256: "a".repeat(64) });
    expect(dto).toMatchObject({ actorEmail: null, correlationId: null, latencyMs: null, model: null, outputChars: null });
    expect(JSON.stringify(dto)).not.toContain("secret");
    expect(Object.keys(dto)).not.toEqual(expect.arrayContaining(["inputText", "outputText", "inputSha256"]));
  });
});
