/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { listDigestUsers, listDueJobs, listOverdueKeys, listWaitingApprovals, loadDigestFacts } from "./store";

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return { ...actual, executeQuery: jest.fn() };
});
const db = require("../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;
const NOW = new Date("2026-10-13T22:00:00Z"); // 07:30 on the 14th in Darwin

type Call = [unknown, string, { name: string; type: unknown; value: unknown }[] | undefined];
const calls = (): Call[] => db.executeQuery.mock.calls as Call[];
const lastSql = (): string => calls()[calls().length - 1][1];
const lastParam = (name: string) => calls()[calls().length - 1][2]?.find((p) => p.name === name);

beforeEach(() => db.executeQuery.mockReset());

describe("listDigestUsers", () => {
  it("reads active users who have a role, with the opt-out flag", async () => {
    db.executeQuery.mockResolvedValue([
      { DigestLastSentOn: null, DigestOptOut: null, DisplayName: "Fay Field", Email: " fay@x.test ", EntraOid: "oid-1", Role: " Facilities ", UserID: 1 },
      { DigestLastSentOn: "2026-10-13", DigestOptOut: false, DisplayName: "Amy", Email: "amy@x.test", Role: "accounts_manager", UserID: 2 },
      { DigestLastSentOn: " ", DigestOptOut: true, DisplayName: null, Email: "", Role: "director", UserID: "3" },
    ]);
    const users = await listDigestUsers(conn);
    expect(lastSql()).toMatch(/FROM dbo\.AppUsers/);
    expect(lastSql()).toMatch(/IsActive = 1/);
    expect(lastSql()).toMatch(/Role IS NOT NULL/);
    expect(lastSql()).toMatch(/EntraOid/);
    // The date comes back as ISO text, so no time zone can shift the day.
    expect(lastSql()).toMatch(/CONVERT\(CHAR\(10\), DigestLastSentOn, 23\) AS DigestLastSentOn/);
    expect(users).toEqual([
      { email: "fay@x.test", entraOid: "oid-1", lastSentOn: null, name: "Fay Field", optedOut: false, role: "facilities", userId: 1 },
      { email: "amy@x.test", entraOid: null, lastSentOn: "2026-10-13", name: "Amy", optedOut: false, role: "accounts_manager", userId: 2 },
      { email: null, entraOid: null, lastSentOn: null, name: "User 3", optedOut: true, role: "director", userId: 3 },
    ]);
  });
});

describe("listWaitingApprovals", () => {
  it("reads quotes and incoming invoices that have not finished their approvals, on live jobs", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ Amount: "4840.00", BuildingID: 1, BuildingName: "Tower A", CreatedAt: new Date("2026-10-12T01:00:00Z"), JobID: 20, Kind: "maintenance", QuoteID: 7, Status: "pending", Title: "Replace pump" }])
      .mockResolvedValueOnce([{ Amount: null, BuildingID: null, BuildingName: null, CreatedAt: new Date("2026-10-11T01:00:00Z"), JobID: 21, JobInvoiceID: 9, Kind: "admin", Status: "approved", Title: "Fix door" }]);
    const rows = await listWaitingApprovals(conn);
    const [quoteSql, invoiceSql] = calls().map((c) => c[1]);
    expect(quoteSql).toMatch(/FROM dbo\.Quotes/);
    expect(quoteSql).toMatch(/Status IN \('pending', 'awaiting_approval', 'awaiting_director'\)/);
    expect(quoteSql).toMatch(/j\.Status = 'Awaiting Approval'/);
    expect(quoteSql).toMatch(/IsArchived = 0/);
    expect(quoteSql).toMatch(/j\.Kind/);
    expect(invoiceSql).toMatch(/j\.Kind/);
    expect(invoiceSql).toMatch(/FROM dbo\.JobInvoices/);
    expect(invoiceSql).toMatch(/Direction = 'incoming'/);
    expect(invoiceSql).toMatch(/Status IN \('pending', 'awaiting_approval', 'approved'\)/);
    expect(invoiceSql).toMatch(/IsArchived = 0/);
    expect(invoiceSql).toMatch(/j\.Status <> 'Done'/);
    expect(rows).toEqual([
      { amount: 4840, buildingId: 1, buildingName: "Tower A", createdAt: new Date("2026-10-12T01:00:00Z"), id: 7, jobId: 20, jobKind: "maintenance", jobTitle: "Replace pump", status: "pending", subject: "quote" },
      { amount: null, buildingId: null, buildingName: null, createdAt: new Date("2026-10-11T01:00:00Z"), id: 9, jobId: 21, jobKind: "admin", jobTitle: "Fix door", status: "approved", subject: "invoice" },
    ]);
  });
});

describe("listDueJobs", () => {
  it("asks for jobs due before the end of today in Darwin, with the bound as a parameter", async () => {
    db.executeQuery.mockResolvedValue([
      { AssignedToUserID: 1, BuildingName: "Tower A", ExpectedProgressUpdate: new Date("2026-10-12T20:00:00Z"), JobID: 30, Kind: "admin", Title: "Paint stairwell" },
    ]);
    const jobs = await listDueJobs(conn, NOW);
    expect(lastSql()).toMatch(/FROM dbo\.Jobs/);
    expect(lastSql()).toMatch(/IsArchived = 0/);
    expect(lastSql()).toMatch(/Status <> 'Done'/);
    expect(lastSql()).toMatch(/AssignedToUserID IS NOT NULL/);
    expect(lastSql()).toMatch(/j\.Kind/);
    expect(lastSql()).toMatch(/ExpectedProgressUpdate < @Before/);
    expect(lastSql()).not.toMatch(/CAST\s*\(\s*j?\.?ExpectedProgressUpdate/i);
    // 00:00 on the 15th in Darwin is 14:30 UTC on the 14th.
    expect(lastParam("Before")).toMatchObject({ type: TYPES.DateTime2, value: new Date("2026-10-14T14:30:00Z") });
    expect(jobs).toEqual([
      { assignedToUserId: 1, buildingName: "Tower A", expectedProgressUpdate: new Date("2026-10-12T20:00:00Z"), jobId: 30, kind: "admin", title: "Paint stairwell" },
    ]);
  });

  it("reads a row with no kind as facilities, like the column's default", async () => {
    db.executeQuery.mockResolvedValue([{ AssignedToUserID: 1, BuildingName: null, ExpectedProgressUpdate: new Date("2026-10-12T20:00:00Z"), JobID: 31, Title: "Mow lawn" }]);
    expect((await listDueJobs(conn, NOW))[0].kind).toBe("facilities");
  });
});

describe("listOverdueKeys", () => {
  it("reads keys still out past their expected return, as a parameterised comparison", async () => {
    db.executeQuery.mockResolvedValue([
      { BatchId: 5, BuildingName: "Tower A", ExpectedReturnAt: new Date("2026-10-11T08:00:00Z"), KeyId: 50, KeyNumber: "K-014" },
    ]);
    const keys = await listOverdueKeys(conn, NOW);
    expect(lastSql()).toMatch(/CheckedInAt IS NULL/);
    expect(lastSql()).toMatch(/IsDeleted = 0/);
    expect(lastSql()).toMatch(/ExpectedReturnAt < @Now/);
    expect(lastParam("Now")).toMatchObject({ type: TYPES.DateTime2, value: NOW });
    expect(keys).toEqual([{ batchId: 5, buildingName: "Tower A", expectedReturnAt: new Date("2026-10-11T08:00:00Z"), keyId: 50, keyNumber: "K-014" }]);
  });
});

describe("loadDigestFacts", () => {
  it("reads users, live escalations, approvals, due jobs and keys, one query at a time", async () => {
    db.executeQuery.mockResolvedValue([]);
    const facts = await loadDigestFacts(conn, NOW);
    expect(facts).toEqual({ dueJobs: [], escalations: [], overdueKeys: [], testKeys: new Set(), users: [], waitingApprovals: [] });
    const sql = calls().map((c) => c[1]).join("\n");
    for (const table of ["dbo.AppUsers", "dbo.Escalations", "dbo.Quotes", "dbo.JobInvoices", "dbo.Jobs", "dbo.KeyCheckoutBatches"]) {
      expect(sql).toContain(table);
    }
  });

  it("lets a database failure through, so the timer fails loudly", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid column name 'DigestOptOut'"));
    await expect(loadDigestFacts(conn, NOW)).rejects.toThrow("DigestOptOut");
  });
});

describe("the source", () => {
  const source = readFileSync(join(__dirname, "store.ts"), "utf8");

  it("only reads: the one write the digest makes lives in sentStore.ts", () => {
    expect(source).not.toMatch(/\b(UPDATE|INSERT|DELETE|MERGE|TRUNCATE)\b/);
  });

  it("never selects *", () => {
    expect(source).not.toMatch(/SELECT\s+\*/i);
  });

  it("leaves test records out of every read (D9, migration 127)", () => {
    expect(source).not.toMatch(/D9: exclude IsTest = 1/);
  });

});

describe("test records (D9)", () => {
  it.each([
    ["quotes", () => listWaitingApprovals(conn), /FROM dbo\.Quotes q[\s\S]*AND q\.IsTest = 0[\s\S]*AND j\.IsTest = 0/],
    ["invoices", () => listWaitingApprovals(conn), /FROM dbo\.JobInvoices ji[\s\S]*AND ji\.IsTest = 0[\s\S]*AND j\.IsTest = 0/],
    ["due jobs", () => listDueJobs(conn, NOW), /FROM dbo\.Jobs j[\s\S]*AND j\.IsTest = 0/],
    ["overdue keys", () => listOverdueKeys(conn, NOW), /AND kco\.IsTest = 0[\s\S]*AND k\.IsTest = 0/],
  ])("leaves test %s out", async (_label, read, pattern) => {
    db.executeQuery.mockResolvedValue([]);
    await read();
    expect(calls().map((c) => c[1]).join("\n")).toMatch(pattern);
  });

  it("drops escalations about a test record and hands the run the test keys", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM dbo\.Escalations/.test(sql)) {
        return [
          { EscalationId: 1, SubjectId: "12", SubjectType: "job" },
          { EscalationId: 2, SubjectId: "13", SubjectType: "job" },
        ];
      }
      if (/DECLARE @Keys TABLE/.test(sql)) return [{ Id: "12", Kind: "job" }];
      return [];
    });
    const facts = await loadDigestFacts(conn, NOW);
    expect(facts.escalations.map((e) => e.escalationId)).toEqual([2]);
    expect([...(facts.testKeys ?? [])]).toEqual(["job:12"]);
  });
});
