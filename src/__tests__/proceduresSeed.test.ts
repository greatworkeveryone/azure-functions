/// <reference types="jest" />
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});
jest.mock("../auth", () => ({
  AppRole: {
    ACCOUNTS: "accounts",
    ACCOUNTS_APPROVAL: "accounts_manager",
    ADMIN: "admin",
    DIRECTOR: "director",
    FACILITIES: "facilities",
    FACILITIES_APPROVAL: "facilities_manager",
    USER: "user",
  },
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  forbiddenResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Forbidden" }, status: 403 }),
  requireRole: jest.fn().mockResolvedValue(null),
  serviceUnavailableResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unavailable" }, status: 503 }),
  rolesForRequest: jest.fn().mockResolvedValue(["director"]),
  unauthorizedResponse: jest.fn(),
  userInfoFromToken: jest.fn().mockReturnValue({ email: "connor@rp.com.au", name: "Connor" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../escalation/store", () => ({ listActiveUsers: jest.fn().mockResolvedValue([]) }));

import { Connection } from "tedious";
import { saveProcedureDraft } from "../functions/saveProcedureDraft";
import { loadSeedEntries, planSeed, runSeed, SEED_FILE, type LibraryState, type SeedEntry } from "../proceduresSeed";

// Loading content/procedures into the library on deploy (beta sprint U4). The
// data is the frontend's exports/procedures-seed.json, kept here byte for byte
// and pinned in both repos. The loader is idempotent by slug and version, and it
// never touches what is already in the library: a published version is immutable.
const PINNED_SHA256 = "a0506d06cee3ee5a96653bef42c9e95ce21327cb480428135df7d3d59beb9564";

const db = require("../db") as { executeQuery: jest.Mock };
const entries = loadSeedEntries();

const entry = (over: Partial<SeedEntry> = {}): SeedEntry => ({
  audience: ["facilities"],
  blocks: [{ id: "keys-0", kind: "paragraph", text: "Keys." }],
  category: "Field work",
  order: 2,
  owner: "Connor",
  slug: "keys",
  status: "published",
  summary: "How keys move",
  title: "Keys",
  updated: "2026-08-11",
  version: 1,
  ...over,
});

describe("the seed file", () => {
  it("is the file the frontend exported: update the hash in both repos with it", () => {
    expect(createHash("sha256").update(readFileSync(SEED_FILE)).digest("hex")).toBe(PINNED_SHA256);
  });

  it("holds the six documents the library ships with, each at version 1", () => {
    expect(entries.map((item) => item.slug)).toEqual(["getting-started", "inspections", "key-register", "tenancy-schedule", "jobs", "from-mybuildings"]);
    expect(entries.every((item) => item.version === 1)).toBe(true);
  });

  it("is accepted, entry by entry, by the same endpoint an editor saves a draft through", async () => {
    for (const item of entries) {
      db.executeQuery.mockClear();
      const response = await saveProcedureDraft(
        { json: async () => ({ audience: item.audience, blocks: item.blocks, category: item.category, slug: item.slug, summary: item.summary, title: item.title }) } as never,
        new InvocationContext(),
      );
      expect({ slug: item.slug, status: response.status }).toEqual({ slug: item.slug, status: 200 });
    }
  });
});

describe("planSeed: what goes in and what is left alone", () => {
  it("inserts a procedure the library does not have, parent row and all", () => {
    expect(planSeed([entry()], {})).toEqual([{ createProcedure: true, entry: entry(), kind: "insert" }]);
  });

  it("fills a procedure row that has no versions, without making the row again", () => {
    expect(planSeed([entry()], { keys: [] })).toEqual([{ createProcedure: false, entry: entry(), kind: "insert" }]);
  });

  it("skips a version that is already there", () => {
    const [action] = planSeed([entry()], { keys: [1] });
    expect(action).toMatchObject({ kind: "skip", slug: "keys" });
  });

  it("leaves alone a procedure that has been worked on in the app: its versions are the source of truth now", () => {
    const [action] = planSeed([entry()], { keys: [2, 3] });
    expect(action).toMatchObject({ kind: "skip", slug: "keys" });
    expect((action as { reason: string }).reason).toMatch(/already has/i);
  });

  it("decides each procedure on its own", () => {
    const plan = planSeed([entry(), entry({ slug: "jobs" }), entry({ slug: "tenancy-schedule" })], { jobs: [1] });
    expect(plan.map((action) => [action.kind, action.kind === "insert" ? action.entry.slug : action.slug])).toEqual([
      ["insert", "keys"],
      ["skip", "jobs"],
      ["insert", "tenancy-schedule"],
    ]);
  });
});

/** A library in memory: SELECTs read it, the seed's guarded INSERT batches write to it. */
function fakeLibrary(initial: LibraryState = {}) {
  const library: LibraryState = JSON.parse(JSON.stringify(initial));
  const writes: Array<{ sql: string; params: Array<{ name: string; value: unknown }> }> = [];
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      return Object.entries(library).flatMap(([slug, versions]): Array<{ Slug: string; VersionNo: number | null }> => (versions.length ? versions.map((VersionNo) => ({ Slug: slug, VersionNo })) : [{ Slug: slug, VersionNo: null }]));
    }
    writes.push({ params, sql });
    const slug = String(params.find((param) => param.name === "Slug")?.value);
    library[slug] = library[slug]?.length ? library[slug] : [Number(params.find((param) => param.name === "VersionNo")?.value)];
    return [];
  });
  return { library, writes };
}
const connection = {} as Connection;
const param = (write: { params: Array<{ name: string; value: unknown }> }, name: string) => write.params.find((entryParam) => entryParam.name === name)?.value;

describe("runSeed", () => {
  beforeEach(() => db.executeQuery.mockReset());

  it("changes nothing on a dry run, and says what it would do", async () => {
    const { writes } = fakeLibrary({ jobs: [1] });
    const log = jest.fn();
    const report = await runSeed(connection, [entry(), entry({ slug: "jobs" })], { apply: false, log });
    expect(writes).toEqual([]);
    expect(report).toMatchObject({ failed: 0, inserted: 0, skipped: 1, wouldInsert: 1 });
    expect(log.mock.calls.flat().join("\n")).toMatch(/keys/);
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const { library, writes } = fakeLibrary();
    const first = await runSeed(connection, entries, { apply: true, log: jest.fn() });
    expect(first).toMatchObject({ inserted: 6, skipped: 0 });
    expect(Object.keys(library).sort()).toEqual(entries.map((item) => item.slug).sort());
    const writesAfterFirst = writes.length;
    const second = await runSeed(connection, entries, { apply: true, log: jest.fn() });
    expect(second).toMatchObject({ inserted: 0, skipped: 6 });
    expect(writes).toHaveLength(writesAfterFirst);
  });

  it("only ever adds: every statement it sends is a guarded INSERT inside one transaction", async () => {
    const { writes } = fakeLibrary();
    await runSeed(connection, entries, { apply: true, log: jest.fn() });
    expect(writes).toHaveLength(6);
    for (const { sql } of writes) {
      expect(sql).toContain("BEGIN TRY");
      expect(sql).toContain("BEGIN TRANSACTION");
      expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = @Slug)");
      expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM dbo.ProcedureVersions WHERE Slug = @Slug)");
      expect(sql).not.toMatch(/\b(DELETE|DROP|TRUNCATE|UPDATE|MERGE|ALTER)\b/i);
    }
  });

  it("stamps a published seed with the approval its markdown carried", async () => {
    const { writes } = fakeLibrary();
    await runSeed(connection, [entry({ approvedBy: "Dee Director", approvedOn: "2026-09-01" })], { apply: true, log: jest.fn() });
    expect(param(writes[0], "Status")).toBe("published");
    expect(param(writes[0], "ApprovedBy")).toBe("Dee Director");
    expect(param(writes[0], "ApprovedAt")).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("says where an approval came from when the markdown carried none: the database will not hold a published version without one", async () => {
    const { writes } = fakeLibrary();
    await runSeed(connection, [entry()], { apply: true, log: jest.fn() });
    expect(param(writes[0], "ApprovedBy")).toBe("Connor (from content/procedures)");
    expect(param(writes[0], "ApprovedAt")).toEqual(new Date("2026-08-11T00:00:00Z"));
    expect(param(writes[0], "PublishedAt")).toEqual(new Date("2026-08-11T00:00:00Z"));
  });

  it("seeds a draft as a draft, with no approval", async () => {
    const { writes } = fakeLibrary();
    await runSeed(connection, [entry({ status: "draft" })], { apply: true, log: jest.fn() });
    expect(param(writes[0], "Status")).toBe("draft");
    for (const name of ["ApprovedBy", "ApprovedAt", "PublishedAt", "ReviewDue"]) expect(param(writes[0], name)).toBeNull();
  });

  it("seeds a retired document as archived", async () => {
    const { writes } = fakeLibrary();
    await runSeed(connection, [entry({ status: "retired" })], { apply: true, log: jest.fn() });
    expect(param(writes[0], "Status")).toBe("archived");
  });

  it("writes the audience as the comma-separated list the library stores, and the blocks as JSON", async () => {
    const { writes } = fakeLibrary();
    await runSeed(connection, [entry({ audience: ["facilities", "accounts"], reviewDue: "2027-01-31" })], { apply: true, log: jest.fn() });
    expect(param(writes[0], "Audience")).toBe("facilities,accounts");
    expect(JSON.parse(String(param(writes[0], "Blocks")))).toEqual(entry().blocks);
    expect(param(writes[0], "ReviewDue")).toEqual(new Date("2027-01-31T00:00:00Z"));
    expect(param(writes[0], "SortOrder")).toBe(2);
  });

  it("goes on to the next document when one fails, and reports the failure", async () => {
    fakeLibrary();
    const original = db.executeQuery.getMockImplementation()!;
    db.executeQuery.mockImplementation(async (conn: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
      if (!/^\s*SELECT/i.test(sql) && params.find((p) => p.name === "Slug")?.value === "keys") throw new Error("constraint");
      return original(conn, sql, params);
    });
    const log = jest.fn();
    const report = await runSeed(connection, [entry(), entry({ slug: "jobs" })], { apply: true, log });
    expect(report).toMatchObject({ failed: 1, inserted: 1 });
    expect(log.mock.calls.flat().join("\n")).toMatch(/keys.*constraint/s);
  });
});
