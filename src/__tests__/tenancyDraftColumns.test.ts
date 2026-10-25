import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TENANCY_CHILD_TABLES, TENANCY_CONTENT_COLUMNS, TENANCY_OTHER_COLUMNS } from "../tenancyDraftContent";

// D11 re-check S1-2 (database-safety rule 1): "Delete empty draft" is allowed only
// when every column a person can fill in on the tenancy is empty and no table
// refers to it. This reads the migrations and fails when a column is added to
// dbo.Tenants, or a table that refers to a tenancy is added, without being named
// in src/tenancyDraftContent.ts. A failure is a stop sign: decide whether the new
// column holds something a person entered (add it to TENANCY_CONTENT_COLUMNS with
// a sentence for the refusal) or is a stamp or counter (TENANCY_OTHER_COLUMNS, with
// the reason), and add the new table to TENANCY_CHILD_TABLES and to the delete's
// fact queries in src/tenancy-records.ts. A regex reading of the files, not a SQL parser.

const MIGRATIONS = join(__dirname, "..", "..", "migrations");

const strip = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/** The text between the parenthesis at `open` and its match. */
function inside(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, at);
    }
  }
  return "";
}

/** A CREATE TABLE body split at its top-level commas. */
function parts(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] === "(") depth += 1;
    else if (body[at] === ")") depth -= 1;
    else if (body[at] === "," && depth === 0) {
      out.push(body.slice(start, at));
      start = at + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

const TABLE_RULE = /^(CONSTRAINT|PRIMARY|CHECK|FOREIGN|UNIQUE)\b/i;
const TENANCY_KEY = /^(TenantId|TenancyId)$/i;

type Event =
  | { at: number; body: string; kind: "create"; table: string }
  | { at: number; column: string; kind: "add" | "alter" | "drop"; table: string; type: string };

function eventsOf(text: string): Event[] {
  const events: Event[] = [];
  for (const match of text.matchAll(/CREATE\s+TABLE\s+dbo\.(\w+)\s*\(/gi)) {
    events.push({ at: match.index, body: inside(text, match.index + match[0].length - 1), kind: "create", table: match[1] });
  }
  const alter = /ALTER\s+TABLE\s+dbo\.(\w+)\s+(ADD|DROP\s+COLUMN|ALTER\s+COLUMN)\s+(?!CONSTRAINT\b)(\w+)(?:\s+([A-Za-z]+\d*(?:\s*\([^)]*\))?))?/gi;
  for (const match of text.matchAll(alter)) {
    const word = match[2].toUpperCase();
    const kind = word === "ADD" ? "add" : word.startsWith("DROP") ? "drop" : "alter";
    events.push({ at: match.index, column: match[3], kind, table: match[1], type: match[4] ?? "" });
  }
  return events.sort((a, b) => a.at - b.at);
}

/** dbo.Tenants after every migration, in order, as name → type; and the tables that carry a tenancy's key. */
function readMigrations(): { children: Set<string>; tenants: Map<string, string> } {
  const tenants = new Map<string, string>();
  const children = new Set<string>();
  const files = readdirSync(MIGRATIONS).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  for (const file of files) {
    for (const event of eventsOf(strip(readFileSync(join(MIGRATIONS, file), "utf8")))) {
      if (event.kind === "create") {
        const columns = parts(event.body)
          .filter((part) => !TABLE_RULE.test(part))
          .map((part) => ({ name: part.split(/\s+/)[0], type: part.match(/^\S+\s+(\w+(?:\s*\([^)]*\))?)/)?.[1] ?? "" }));
        if (event.table === "Tenants") {
          tenants.clear();
          for (const column of columns) tenants.set(column.name, column.type);
        } else if (columns.some((column) => TENANCY_KEY.test(column.name))) children.add(event.table);
      } else if (event.table === "Tenants") {
        if (event.kind === "drop") tenants.delete(event.column);
        else tenants.set(event.column, event.type);
      } else if (event.kind === "add" && TENANCY_KEY.test(event.column)) children.add(event.table);
    }
  }
  return { children, tenants };
}

const { children, tenants } = readMigrations();
const named = new Set([...TENANCY_CONTENT_COLUMNS.map((entry) => entry.column), ...Object.keys(TENANCY_OTHER_COLUMNS)]);

describe("the empty-draft rule names every column of dbo.Tenants (S1-2)", () => {
  it("reads the table as the migrations leave it", () => {
    expect([...tenants.keys()]).toEqual(expect.arrayContaining(["InfoSheetSections", "LeaseAdministration", "MiscFees", "Incentives", "ScheduledRateSteps", "LegalName"]));
    expect(tenants.has("RentBasis")).toBe(false);
    expect(tenants.get("Levels")).toBeUndefined();
  });

  it("has no column that is neither content nor a named stamp or counter", () => {
    expect([...tenants.keys()].filter((column) => !named.has(column))).toEqual([]);
  });

  it("names no column the table no longer has", () => {
    expect([...named].filter((column) => !tenants.has(column))).toEqual([]);
  });

  it("counts every long-text column (JSON or free text) as content", () => {
    const longText = [...tenants].filter(([, type]) => /NVARCHAR\s*\(\s*MAX\s*\)/i.test(type)).map(([column]) => column);
    expect(longText.length).toBeGreaterThan(8);
    expect(longText.filter((column) => !TENANCY_CONTENT_COLUMNS.some((entry) => entry.column === column))).toEqual([]);
  });

  it("lists a column once", () => {
    const all = [...TENANCY_CONTENT_COLUMNS.map((entry) => entry.column), ...Object.keys(TENANCY_OTHER_COLUMNS)];
    expect(all.filter((column, index) => all.indexOf(column) !== index)).toEqual([]);
  });
});

describe("the empty-draft rule names every table that refers to a tenancy (S1-2)", () => {
  it("has every table the migrations give a tenant or tenancy key", () => {
    expect([...children].sort()).toEqual(expect.arrayContaining(["Jobs", "Keys", "TenantNotes", "RegisterDocuments", "ScheduleChangeRequests"]));
    expect([...children].filter((table) => !(TENANCY_CHILD_TABLES as readonly string[]).includes(table))).toEqual([]);
  });

  it("lists a table once", () => {
    expect(new Set(TENANCY_CHILD_TABLES).size).toBe(TENANCY_CHILD_TABLES.length);
  });
});
