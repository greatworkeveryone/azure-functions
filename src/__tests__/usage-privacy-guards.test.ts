/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Guards for what usage analytics may store (PLAN §14): which pages, how long, what kind of device,
// who by token. Never what a person types, page content, record contents or a precise location. These
// read the migration and the source as text, so adding a column or a field that would carry such a
// thing fails here until someone has decided it should.

const ROOT = join(__dirname, "..", "..");
const migration = readFileSync(join(ROOT, "migrations", "178_usage_analytics.sql"), "utf8");
const sqlOnly = migration.replace(/--.*$/gm, "");

function tableColumns(table: string): string[] {
  const body = sqlOnly.match(new RegExp(`CREATE TABLE dbo\\.${table} \\(([\\s\\S]*?)\\n  \\);`))?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(CONSTRAINT|\)|\()/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

describe("migration 178", () => {
  it("creates exactly the four usage tables, with exactly these columns", () => {
    expect(tableColumns("UsageDevices")).toEqual(["DeviceId", "FirstSeenAt", "LastSeenAt", "DeviceClass", "BrowserFamily", "OsFamily", "IsPersistent", "Label", "LabelledBy", "LabelledAt"]);
    expect(tableColumns("UsageSessions")).toEqual(["SessionId", "UserId", "DeviceId", "StartedAt", "LastHeartbeatAt", "ActiveSeconds"]);
    expect(tableColumns("UsageViews")).toEqual(["ViewId", "SessionId", "ViewSeq", "ModuleKey", "RoutePattern", "EnteredAt", "ActiveSeconds", "IsContinuation"]);
    expect(tableColumns("UsageDaily")).toEqual(["Day", "UserId", "ModuleKey", "DeviceClass", "Sessions", "Views", "ActiveSeconds", "RolledUpAt"]);
    expect([...sqlOnly.matchAll(/CREATE TABLE (dbo\.\w+)/g)].map((m) => m[1]).sort()).toEqual(["dbo.UsageDaily", "dbo.UsageDevices", "dbo.UsageSessions", "dbo.UsageViews"]);
  });

  it("has no column for an address, a user agent string, a city, content or free text beyond a route pattern and a device label", () => {
    const columns = ["UsageDevices", "UsageSessions", "UsageViews", "UsageDaily"].flatMap(tableColumns);
    expect(columns.filter((name) => /Ip|Agent|City|Country|Location|Lat|Lon|Title|Text|Body|Query|Url|Content|Email|Name$/i.test(name) && !/^LabelledBy$/.test(name))).toEqual([]);
  });

  it("is additive: no drop, delete, truncate, update or alter of anything", () => {
    expect(sqlOnly).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER\s+COLUMN)\b/i);
    expect(sqlOnly.match(/CREATE TABLE/g)?.length).toBe(sqlOnly.match(/IF OBJECT_ID\('dbo\.Usage\w+', 'U'\) IS NULL/g)?.length);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}
const usageSources = [...sourceFiles(join(ROOT, "src", "usage")), ...readdirSync(join(ROOT, "src", "functions")).filter((f) => /^(post|get|label|run)Usage|^usage(Purge|Rollup)Timer/.test(f) && !f.endsWith(".test.ts")).map((f) => join(ROOT, "src", "functions", f))];

describe("the usage source", () => {
  it("finds the files it is guarding", () => {
    expect(usageSources.length).toBeGreaterThan(20);
  });

  it("never reads the request's address, user agent or location headers", () => {
    for (const file of usageSources) {
      expect({ file: relative(ROOT, file), hit: /user-agent|x-forwarded-for|x-azure-clientip|clientIp|cf-ipcountry|headers\.get\(\s*["'](?!authorization)/i.test(readFileSync(file, "utf8")) }).toEqual({ file: relative(ROOT, file), hit: false });
    }
  });

  it("reads the person only from the token, never from the body", () => {
    const post = readFileSync(join(ROOT, "src", "functions", "postUsageEvents.ts"), "utf8");
    expect(post).toMatch(/oidFromToken\(token\)/);
    expect(post).not.toMatch(/body\.(user|userId|oid|email)|batch\.(user|oid)/);
    const validate = readFileSync(join(ROOT, "src", "usage", "validate.ts"), "utf8");
    expect(validate).not.toMatch(/\b(userId|oid|email)\b/i);
  });

  it("deletes only in the purge, and only the two raw tables", () => {
    const deleting = usageSources.filter((file) => /DELETE\s+FROM/i.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file));
    expect(deleting).toEqual([join("src", "usage", "purge.ts")]);
    const purge = readFileSync(join(ROOT, "src", "usage", "purge.ts"), "utf8");
    expect([...purge.matchAll(/DELETE\s+FROM\s+(dbo\.\w+)/gi)].map((m) => m[1])).toEqual(["dbo.UsageViews", "dbo.UsageSessions"]);
  });

  it("never selects stored text from the other logs it reads", () => {
    for (const name of ["email", "ai", "finance"]) {
      const text = readFileSync(join(ROOT, "src", "usage", "queries", `${name}.ts`), "utf8");
      expect(text).not.toMatch(/InputText|OutputText|BodyMarkdown|RequestBody|ResponseBody|MergeValues|SELECT \*/);
    }
  });
});
