/// <reference types="jest" />

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

import { MyobRequestRefusedError } from "../myob-api-log";
import { readbackMode, runReadback, type ReadbackDeps } from "./readbackRun";
import type { ProposalRow } from "./proposalRow";

const db = require("../db") as Record<string, jest.Mock>;
const NOW = new Date("2026-10-15T00:12:00Z");
const ACTORS = { ledger: { kind: "system" as const, name: "t" }, myob: { kind: "system" as const, name: "t" } };
const rows = [1, 2, 3].map((proposalId) => ({ proposalId }) as ProposalRow);
const verdict = (discrepancy: unknown) => ({ record: {}, verdict: { advanceVersion: !discrepancy, discrepancy, paid: { balanceDue: null, state: null }, status: "Open" } });

function deps(): ReadbackDeps & Record<keyof ReadbackDeps, jest.Mock> {
  return {
    read: jest.fn()
      .mockResolvedValueOnce(verdict(null))
      .mockResolvedValueOnce(verdict({ fields: [{ label: "Amount" }], missing: false }))
      .mockResolvedValueOnce(verdict({ fields: [], missing: true })),
    record: jest.fn().mockResolvedValue({ discrepancyChanged: true, versionAdvanced: false }),
    select: jest.fn().mockResolvedValue(rows),
  } as unknown as ReadbackDeps & Record<keyof ReadbackDeps, jest.Mock>;
}

const run = (d: ReadbackDeps, dryRun = false, log = jest.fn()) => runReadback({} as never, { actors: ACTORS, dryRun, limit: 50, log, now: NOW }, d);

beforeEach(() => jest.clearAllMocks());

describe("readbackMode", () => {
  it("is off unless asked, and a dry run wins", () => {
    expect(readbackMode({})).toBe("off");
    expect(readbackMode({ MYOB_READBACK_ENABLED: "TRUE" })).toBe("off");
    expect(readbackMode({ MYOB_READBACK_ENABLED: "true" })).toBe("live");
    expect(readbackMode({ MYOB_READBACK_DRY_RUN: "true", MYOB_READBACK_ENABLED: "true" })).toBe("dry-run");
  });
});

describe("runReadback", () => {
  it("reads each selected record, records each in its own transaction, and counts what it saw", async () => {
    const d = deps();
    const counts = await run(d);
    expect(d.select).toHaveBeenCalledWith(expect.anything(), 50, NOW);
    expect(d.record).toHaveBeenCalledTimes(3);
    expect(db.commitTransaction).toHaveBeenCalledTimes(3);
    expect(counts).toMatchObject({ discrepanciesChanged: 3, errors: 0, matched: 1, missing: 1, read: 3, selected: 3, withDifferences: 1 });
  });

  it("in a dry run reads and logs, and writes nothing", async () => {
    const d = deps();
    const log = jest.fn();
    const counts = await run(d, true, log);
    expect(d.record).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("differs: Amount"));
    expect(counts).toMatchObject({ dryRun: true, read: 3 });
  });

  it("counts a refusal inside Floorplan (purchases.read off, file off) apart from failures, and keeps going", async () => {
    const d = deps();
    d.read.mockReset()
      .mockRejectedValueOnce(new MyobRequestRefusedError("controls", "purchases.read is switched off"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(verdict(null));
    const counts = await run(d);
    expect(counts).toMatchObject({ errors: 1, matched: 1, read: 1, refused: 1 });
    expect(d.record).toHaveBeenCalledTimes(1);
  });

  it("rolls back a record whose write fails, and counts it", async () => {
    const d = deps();
    d.record.mockRejectedValueOnce(new Error("deadlock"));
    const counts = await run(d);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(counts.errors).toBe(1);
  });
});
