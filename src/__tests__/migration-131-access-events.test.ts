import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 131 (S10) must be additive and safe to run twice: production
// applies migrations at startup and a failing one stops the API. These read the
// file as text; nothing touches a database.

const RAW = readFileSync(join(__dirname, "..", "..", "migrations", "131_access_events.sql"), "utf8");
const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const BATCHES = SQL.split(/^GO\s*$/im)
  .map((b) => b.trim())
  .filter(Boolean);

describe("migration 131 access_events", () => {
  it("contains no DROP, TRUNCATE, DELETE or UPDATE", () => {
    expect(SQL).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(SQL).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  it("guards every CREATE and ALTER with an existence check that comes first", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|COL_LENGTH|OBJECT_ID)\b/i;
    for (const batch of BATCHES) {
      const ddl = batch.search(/\b(CREATE|ALTER)\b/i);
      if (ddl === -1) continue;
      expect(batch).toMatch(guard);
    }
  });

  it("creates dbo.AccessEvents with the columns the recorder inserts", () => {
    const source = readFileSync(join(__dirname, "..", "access", "accessEvents.ts"), "utf8");
    const insert = source.match(/INSERT INTO dbo\.AccessEvents\s*\(([^)]*)\)/);
    expect(insert).not.toBeNull();
    const columns = (insert as RegExpMatchArray)[1].split(",").map((c) => c.trim());
    for (const column of ["Oid", "Role", "At", "IpHash", "Country", "City", "UserAgentHash", "LocalHour", "Kind", "Anomaly", "Detail"]) {
      expect(columns).toContain(column);
    }
    for (const column of columns) expect(SQL).toMatch(new RegExp(`\\b${column}\\b`));
  });

  it("pins Kind and Anomaly to the decision-15 vocabularies", () => {
    expect(SQL).toMatch(/Kind IN \(N?'signin', N?'request', N?'money'\)/);
    expect(SQL).toMatch(/Anomaly IN \(N?'none', N?'new_country', N?'outside_window', N?'new_device', N?'burst'\)/);
  });

  it("adds AppUsers.AccessProfile as nullable JSON", () => {
    expect(SQL).toMatch(/ALTER TABLE dbo\.AppUsers ADD AccessProfile NVARCHAR\(1000\) NULL/);
    expect(SQL).toMatch(/AccessProfile IS NULL OR ISJSON\(AccessProfile\) = 1/);
  });

  it("indexes the device lookup and the time-ordered reads", () => {
    expect(SQL).toContain("IX_AccessEvents_Oid_Device");
    expect(SQL).toContain("IX_AccessEvents_At");
  });
});
