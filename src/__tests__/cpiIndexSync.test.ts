/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, TYPES } from "tedious";
import { CpiRegion, CpiSeries, parseCpiResponse } from "../cpiAbs";
import { planCpiSync, syncCpiIndex } from "../cpiIndexSync";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureMessage: jest.fn() } }));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const { Sentry } = require("../sentry") as { Sentry: { captureMessage: jest.Mock } };

// Real ABS responses (docs/lease-ops/wp22-step0-abs-structure.md), parsed by the
// real parser, so these tests run on real values and a real 106-quarter shape.
const NOW = new Date("2026-10-13T12:00:00Z");
function load(file: string, region: CpiRegion): CpiSeries {
  const text = readFileSync(join(__dirname, "fixtures", "abs-cpi", file), "utf8");
  return parseCpiResponse(JSON.parse(text), region, { now: NOW });
}
const AUS = load("cpi-2.0.0-aus-q-from-2000q1.json", "AUS");
const DARWIN = load("cpi-2.0.0-darwin-q-from-2000q1.json", "DARWIN");
const NEW_BASE = "Sep 2025 = 100.0";

interface Stored {
  Period: string;
  IndexValue: number;
  ReferenceBase: string | null;
  SourceKey: string | null;
  Dataflow: string | null;
}
interface Param {
  name: string;
  type: unknown;
  value: unknown;
  options?: unknown;
}
interface Call {
  sql: string;
  params: Param[];
}

const matching = (series: CpiSeries): Stored[] =>
  series.observations.map((o) => ({
    Period: o.period,
    IndexValue: o.value,
    ReferenceBase: series.referenceBase,
    SourceKey: series.sourceKey,
    Dataflow: series.dataflow,
  }));

let calls: Call[];
let events: string[];

function installDb(
  stored: Partial<Record<CpiRegion, Stored[]>>,
  failWrite?: { nth: number; error: Error },
): void {
  calls = [];
  events = [];
  let writes = 0;
  db.beginTransaction.mockImplementation(async () => void events.push("begin"));
  db.commitTransaction.mockImplementation(async () => void events.push("commit"));
  db.rollbackTransaction.mockImplementation(async () => void events.push("rollback"));
  db.executeQuery.mockImplementation(
    async (_connection: unknown, sql: string, params: Param[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        const region = params.find((p) => p.name === "Region")?.value as CpiRegion;
        events.push(`read ${region}`);
        return stored[region] ?? [];
      }
      if (sql.includes("MERGE")) {
        writes++;
        if (failWrite && writes === failWrite.nth) throw failWrite.error;
        events.push("merge");
        return [];
      }
      events.push("confirm");
      return [];
    },
  );
}

const merges = (): Call[] => calls.filter((c) => c.sql.includes("MERGE"));
const confirms = (): Call[] => calls.filter((c) => c.sql.includes("UPDATE dbo.CpiIndex"));
const valuesOf = (call: Call): Record<string, unknown> =>
  Object.fromEntries(call.params.map((p) => [p.name, p.value]));

const connection = {} as Connection;
const logger = { log: jest.fn(), warn: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  installDb({});
});

describe("syncCpiIndex — first fill", () => {
  it("inserts every quarter of both regions in one transaction, after reading stored state", async () => {
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(merges()).toHaveLength(212);
    expect(events.filter((e) => e === "begin")).toHaveLength(1);
    expect(events.filter((e) => e === "commit")).toHaveLength(1);
    expect(events.indexOf("begin")).toBeGreaterThan(events.lastIndexOf("read DARWIN"));
    expect(events.indexOf("merge")).toBeGreaterThan(events.indexOf("begin"));
    expect(events[events.length - 1]).toBe("commit");
    expect(db.rollbackTransaction).not.toHaveBeenCalled();

    expect(result.regions[0]).toMatchObject({
      region: "AUS",
      referenceBase: NEW_BASE,
      baseChanged: false,
      previousBases: [],
      fetched: 106,
      inserted: 106,
      updated: 0,
      restated: 0,
      unchanged: 0,
      newPeriods: [],
      latestPeriod: "2026-Q2",
    });
    expect(result.regions[1]).toMatchObject({ region: "DARWIN", inserted: 106 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("writes value, base and source with parameters, binding the decimal at scale 3", async () => {
    await syncCpiIndex(connection, [AUS, DARWIN], logger);

    const call = merges().find((c) => {
      const v = valuesOf(c);
      return v.Region === "DARWIN" && v.Period === "2026-Q2";
    }) as Call;
    expect(valuesOf(call)).toMatchObject({
      Region: "DARWIN",
      Period: "2026-Q2",
      IndexValue: 102.35,
      ReferenceBase: NEW_BASE,
      SourceKey: "1.10001.10.7.Q",
      Dataflow: "CPI 2.0.0",
    });
    expect(call.params.find((p) => p.name === "IndexValue")).toMatchObject({
      type: TYPES.Decimal,
      options: { precision: 10, scale: 3 },
    });
    expect(call.sql).toContain("@IndexValue");
    expect(call.sql).not.toContain("102.35");
    expect(call.sql).toContain("HOLDLOCK");
  });
});

describe("syncCpiIndex — steady state and new quarters", () => {
  it("leaves matching rows alone and only confirms them", async () => {
    installDb({ AUS: matching(AUS), DARWIN: matching(DARWIN) });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(merges()).toHaveLength(0);
    expect(confirms().map((c) => valuesOf(c))).toEqual([
      { Region: "AUS", FirstPeriod: "2000-Q1", LastPeriod: "2026-Q2" },
      { Region: "DARWIN", FirstPeriod: "2000-Q1", LastPeriod: "2026-Q2" },
    ]);
    expect(result.regions.map((r) => [r.inserted, r.restated, r.unchanged])).toEqual([
      [0, 0, 106],
      [0, 0, 106],
    ]);
    expect(events[events.length - 1]).toBe("commit");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats float noise in a stored decimal as unchanged", async () => {
    const stored = matching(AUS).map((r) => ({ ...r, IndexValue: r.IndexValue + 1e-12 }));
    installDb({ AUS: stored, DARWIN: matching(DARWIN) });
    await syncCpiIndex(connection, [AUS, DARWIN], logger);
    expect(merges()).toHaveLength(0);
  });

  it("inserts only the newly published quarter and reports it", async () => {
    installDb({
      AUS: matching(AUS).slice(0, 105),
      DARWIN: matching(DARWIN).slice(0, 105),
    });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(merges().map((c) => valuesOf(c))).toEqual([
      expect.objectContaining({ Region: "AUS", Period: "2026-Q2", IndexValue: 102.31 }),
      expect.objectContaining({ Region: "DARWIN", Period: "2026-Q2", IndexValue: 102.35 }),
    ]);
    expect(result.regions[0]).toMatchObject({ inserted: 1, unchanged: 105, newPeriods: ["2026-Q2"] });
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/AUS: new period\(s\) 2026-Q2/));
  });

  it("rewrites a single quarter whose value ABS revised", async () => {
    const stored = matching(AUS).map((r) =>
      r.Period === "2010-Q1" ? { ...r, IndexValue: r.IndexValue + 0.5 } : r,
    );
    installDb({ AUS: stored, DARWIN: matching(DARWIN) });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(merges().map((c) => valuesOf(c).Period)).toEqual(["2010-Q1"]);
    expect(result.regions[0]).toMatchObject({
      updated: 1,
      restated: 0,
      unchanged: 105,
      baseChanged: false,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

const OLD_BASE = "Dec 2011 = 100.0";
const oldBaseRows = (series: CpiSeries, keep: number): Stored[] =>
  matching(series)
    .slice(0, keep)
    .map((r) => ({
      ...r,
      IndexValue: Math.round(r.IndexValue * 1.4 * 100) / 100,
      ReferenceBase: OLD_BASE,
      Dataflow: "CPI 1.0.0",
    }));
// A row from before the 2000-Q1 start period: a fetch never rewrites it.
const preRangeRow = (base: string): Stored => ({
  Period: "1999-Q4",
  IndexValue: 47.2,
  ReferenceBase: base,
  SourceKey: "1.10001.10.50.Q",
  Dataflow: "CPI 1.0.0",
});

describe("syncCpiIndex — rebase", () => {
  it("restates every existing row on the new base, not just the new quarter", async () => {
    installDb({ AUS: oldBaseRows(AUS, 105), DARWIN: oldBaseRows(DARWIN, 105) });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    // 105 old-base rows restated + 1 new quarter, per region.
    expect(merges()).toHaveLength(212);
    expect(merges().every((c) => valuesOf(c).ReferenceBase === NEW_BASE)).toBe(true);
    expect(merges().every((c) => valuesOf(c).Dataflow === "CPI 2.0.0")).toBe(true);
    expect(result.regions[0]).toMatchObject({
      baseChanged: true,
      previousBases: [OLD_BASE],
      restated: 105,
      inserted: 1,
      newPeriods: ["2026-Q2"],
    });
  });

  it("logs the base change and sends a Sentry warning for each region", async () => {
    installDb({ AUS: oldBaseRows(AUS, 106), DARWIN: oldBaseRows(DARWIN, 106) });
    await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /AUS: ABS reference base changed from "Dec 2011 = 100\.0" to "Sep 2025 = 100\.0"; restated 106 existing row/,
      ),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("reference base changed"),
      expect.objectContaining({
        level: "warning",
        extra: expect.objectContaining({
          region: "AUS",
          previousBases: [OLD_BASE],
          referenceBase: NEW_BASE,
          restated: 106,
        }),
      }),
    );
  });

  it("backfills rows written before the base was recorded without calling it a rebase", async () => {
    const legacy = (series: CpiSeries): Stored[] =>
      matching(series).map((r) => ({ ...r, ReferenceBase: null, SourceKey: null, Dataflow: null }));
    installDb({ AUS: legacy(AUS), DARWIN: legacy(DARWIN) });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(merges()).toHaveLength(212);
    expect(result.regions[0]).toMatchObject({
      baseChanged: false,
      previousBases: [],
      updated: 106,
      restated: 0,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

// After a rebase the first run restates 2000-Q1 onwards, but a row from before
// the start period keeps the old base for good. It has to be reported, and it
// must not make every later run look like a fresh rebase (a Sentry warning a
// night, forever).
describe("syncCpiIndex — rows older than the fetched range", () => {
  it("a pre-range row left on the old base is not a rebase, on this run or any later one", async () => {
    installDb({ AUS: [preRangeRow(OLD_BASE), ...matching(AUS)], DARWIN: matching(DARWIN) });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(result.regions[0]).toMatchObject({
      baseChanged: false,
      previousBases: [NEW_BASE],
      updated: 0,
      restated: 0,
      unchanged: 106,
    });
    expect(merges()).toHaveLength(0);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/reference base changed/));
  });

  it("still warns that the row was not refreshed, and leaves it out of the confirmed range", async () => {
    installDb({ AUS: [preRangeRow(OLD_BASE), ...matching(AUS)], DARWIN: matching(DARWIN) });
    await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /AUS: 1 stored row\(s\) older than the fetched range were not refreshed \(1999-Q4 to 1999-Q4\)/,
      ),
    );
    expect(confirms().map((c) => valuesOf(c).FirstPeriod)).toEqual(["2000-Q1", "2000-Q1"]);
  });

  it("still reports a real rebase of the fetched range, from the in-range bases only", async () => {
    installDb({
      AUS: [preRangeRow("Dec 2005 = 100.0"), ...oldBaseRows(AUS, 106)],
      DARWIN: matching(DARWIN),
    });
    const result = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(result.regions[0]).toMatchObject({
      baseChanged: true,
      previousBases: [OLD_BASE],
      restated: 106,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /AUS: ABS reference base changed from "Dec 2011 = 100\.0" to "Sep 2025 = 100\.0"/,
      ),
    );
  });
});

describe("syncCpiIndex — refusals leave the table untouched", () => {
  it("refuses to write when ABS's newest period is older than what is stored", async () => {
    const ahead: Stored = { ...matching(AUS)[105], Period: "2026-Q3" };
    installDb({ AUS: [...matching(AUS), ahead], DARWIN: matching(DARWIN) });

    await expect(syncCpiIndex(connection, [AUS, DARWIN], logger)).rejects.toThrow(
      /AUS: ABS latest period 2026-Q2 is older than stored 2026-Q3; refusing to write a regression/,
    );
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(merges()).toHaveLength(0);
    expect(confirms()).toHaveLength(0);
  });

  it("refuses a value that DECIMAL(10,3) would silently round, before touching the database", async () => {
    const fine: CpiSeries = {
      ...AUS,
      observations: AUS.observations.map((o, i) => (i === 10 ? { ...o, value: 100.1234 } : o)),
    };

    await expect(syncCpiIndex(connection, [fine, DARWIN], logger)).rejects.toThrow(
      /AUS 2002-Q3: 100\.1234 does not fit dbo\.CpiIndex\.IndexValue DECIMAL\(10,3\)/,
    );
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and rethrows when a write fails part way through", async () => {
    const failure = new Error("deadlock victim");
    installDb({}, { nth: 5, error: failure });

    await expect(syncCpiIndex(connection, [AUS, DARWIN], logger)).rejects.toBe(failure);

    expect(events.filter((e) => e === "merge")).toHaveLength(4);
    expect(events).toContain("rollback");
    expect(events).not.toContain("commit");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("still throws the original error if the rollback itself fails", async () => {
    const failure = new Error("deadlock victim");
    installDb({}, { nth: 1, error: failure });
    db.rollbackTransaction.mockRejectedValue(new Error("rollback boom"));

    await expect(syncCpiIndex(connection, [AUS, DARWIN], logger)).rejects.toBe(failure);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/rollback failed: rollback boom/));
  });

  it("does not commit or report anything when the commit itself fails", async () => {
    installDb({});
    db.commitTransaction.mockRejectedValue(new Error("commit failed"));

    await expect(syncCpiIndex(connection, [AUS, DARWIN], logger)).rejects.toThrow("commit failed");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(logger.log).not.toHaveBeenCalled();
  });
});

describe("planCpiSync — dry run", () => {
  const rebaseState = () => ({
    AUS: oldBaseRows(AUS, 105),
    DARWIN: oldBaseRows(DARWIN, 105),
  });
  const planLine = (region: string, counts: string, change: string) =>
    `cpi sync dry run ${region}: base "${NEW_BASE}", ${counts}, base change ${change}, latest 2026-Q2`;

  it("only reads: no transaction, no MERGE, no UPDATE, nothing sent to Sentry", async () => {
    installDb(rebaseState());
    await planCpiSync(connection, [AUS, DARWIN], logger);

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => /^\s*SELECT/i.test(c.sql))).toBe(true);
    expect(merges()).toHaveLength(0);
    expect(confirms()).toHaveLength(0);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs each region's plan: insert / update / restate, base change and latest period", async () => {
    installDb(rebaseState());
    const result = await planCpiSync(connection, [AUS, DARWIN], logger);

    const counts = "would insert 1, update 0, restate 105, leave 0 unchanged";
    const change = 'yes (from "Dec 2011 = 100.0")';
    expect(logger.log).toHaveBeenCalledWith(planLine("AUS", counts, change));
    expect(logger.log).toHaveBeenCalledWith(planLine("DARWIN", counts, change));
    expect(logger.log).toHaveBeenCalledWith("cpi sync dry run: nothing was written");
    expect(result.regions.map((r) => [r.inserted, r.updated, r.restated, r.baseChanged])).toEqual([
      [1, 0, 105, true],
      [1, 0, 105, true],
    ]);
  });

  it("says base change no when nothing is new", async () => {
    installDb({ AUS: matching(AUS), DARWIN: matching(DARWIN) });
    await planCpiSync(connection, [AUS, DARWIN], logger);

    expect(logger.log).toHaveBeenCalledWith(
      planLine("AUS", "would insert 0, update 0, restate 0, leave 106 unchanged", "no"),
    );
  });

  it("tells an ABS revision (update) from a new quarter (insert) and from a rebase (restate)", async () => {
    const revised = matching(AUS)
      .slice(0, 105)
      .map((r) => (r.Period === "2010-Q1" ? { ...r, IndexValue: r.IndexValue + 0.5 } : r));
    installDb({ AUS: revised, DARWIN: matching(DARWIN) });
    const result = await planCpiSync(connection, [AUS, DARWIN], logger);

    expect(result.regions[0]).toMatchObject({
      inserted: 1,
      updated: 1,
      restated: 0,
      unchanged: 104,
      baseChanged: false,
      newPeriods: ["2026-Q2"],
    });
    expect(logger.log).toHaveBeenCalledWith(
      planLine("AUS", "would insert 1, update 1, restate 0, leave 104 unchanged", "no"),
    );
    expect(logger.log).toHaveBeenCalledWith("cpi sync dry run AUS: new period(s) 2026-Q2");
  });

  it("does not take a pre-range row on an old base for a base change, but still reports it", async () => {
    installDb({ AUS: [preRangeRow(OLD_BASE), ...matching(AUS)], DARWIN: matching(DARWIN) });
    await planCpiSync(connection, [AUS, DARWIN], logger);

    expect(logger.log).toHaveBeenCalledWith(
      planLine("AUS", "would insert 0, update 0, restate 0, leave 106 unchanged", "no"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/AUS: 1 stored row\(s\) older than the fetched range/),
    );
  });

  it("returns the plan a real run then carries out", async () => {
    installDb(rebaseState());
    const planned = await planCpiSync(connection, [AUS, DARWIN], logger);

    jest.clearAllMocks();
    installDb(rebaseState());
    const synced = await syncCpiIndex(connection, [AUS, DARWIN], logger);

    expect(planned).toEqual(synced);
    expect(merges()).toHaveLength(212);
  });

  it("refuses what a real run refuses, and still writes nothing", async () => {
    const ahead = { ...matching(AUS)[105], Period: "2026-Q3" };
    installDb({ AUS: [...matching(AUS), ahead], DARWIN: matching(DARWIN) });
    await expect(planCpiSync(connection, [AUS, DARWIN], logger)).rejects.toThrow(
      /refusing to write a regression/,
    );
    expect(merges()).toHaveLength(0);

    jest.clearAllMocks();
    installDb({});
    const unrepresentable: CpiSeries = {
      ...AUS,
      observations: AUS.observations.map((o, i) => (i === 10 ? { ...o, value: 100.1234 } : o)),
    };
    await expect(planCpiSync(connection, [unrepresentable, DARWIN], logger)).rejects.toThrow(
      /does not fit dbo\.CpiIndex\.IndexValue DECIMAL\(10,3\)/,
    );
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });
});
