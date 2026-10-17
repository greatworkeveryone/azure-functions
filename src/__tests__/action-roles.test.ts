/// <reference types="jest" />
// The who-can-do-what table (beta sprint J4) and its export. The JSON the
// frontend reads must be this table, byte for byte: its SHA-256 is pinned here
// and in the frontend's src/constants/actionRoles.test.ts, so changing the
// table fails both until the file is re-exported, copied and re-pinned.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { ACTION_ROLES, ALL_ROLES, exportActionRoles, rolesFor, type ActionRoles } from "../action-roles";
import { AppRole, rolesPassGate } from "../auth";

export {};

const EXPORT = join(__dirname, "..", "..", "exports", "action-roles.json");
const PINNED_SHA256 = "57bfa52231a45a64539089d3e0feb6552894a30372614c658e3f83c5d045477b";
const entries = Object.entries(ACTION_ROLES) as [string, ActionRoles][];

describe("the export", () => {
  it("is the table as it stands: run npm run export-roles after changing it", () => {
    expect(JSON.parse(readFileSync(EXPORT, "utf8"))).toEqual(exportActionRoles());
    expect(readFileSync(EXPORT, "utf8")).toBe(`${JSON.stringify(exportActionRoles(), null, 2)}\n`);
  });

  it("is the file the frontend pins: update the hash in both repos with it", () => {
    expect(createHash("sha256").update(readFileSync(EXPORT)).digest("hex")).toBe(PINNED_SHA256);
  });
});

describe("the table", () => {
  it("lists each route under one capability only", () => {
    const routes = entries.flatMap(([, entry]) => entry.routes);
    expect(routes.filter((route, index) => routes.indexOf(route) !== index)).toEqual([]);
  });

  it("refuses only roles its gate admits, and always says why", () => {
    for (const [capability, entry] of entries) {
      const admitted = entry.match === "exact" ? [...entry.gate] : ALL_ROLES.filter((role) => rolesPassGate([role], entry.gate));
      expect({ capability, stray: (entry.refused ?? []).filter((role) => !admitted.includes(role)) }).toEqual({ capability, stray: [] });
      expect({ capability, why: entry.why.length > 10 }).toEqual({ capability, why: true });
    }
  });

  it("works each entry out by requireRole's hierarchy unless it says exact", () => {
    expect(rolesFor({ gate: [AppRole.ACCOUNTS], routes: [], why: "accounts gate, by hierarchy" })).toEqual([
      AppRole.ACCOUNTS,
      AppRole.ACCOUNTS_APPROVAL,
      AppRole.ADMIN,
      AppRole.CFO,
      AppRole.DIRECTOR,
    ]);
    expect(rolesFor({ gate: [AppRole.CFO], match: "exact", routes: [], why: "cfo only, literally" })).toEqual([AppRole.CFO]);
    expect(rolesFor({ gate: [AppRole.DIRECTOR], refused: [AppRole.ADMIN], routes: [], why: "director, admin refused" })).toEqual([
      AppRole.DIRECTOR,
    ]);
  });

  // Decision 1: field officers create jobs, request quotes, add received quotes
  // and invoices (typed or from email) and mark work complete; they approve nothing.
  it("lets field officers create, request and add, and approve nothing (decision 1)", () => {
    const officer = (capability: keyof typeof ACTION_ROLES) => rolesFor(ACTION_ROLES[capability]).includes(AppRole.FACILITIES);
    for (const capability of ["editJobs", "addQuoteContractor", "createQuote", "createInvoice", "promoteEmail", "completePurchaseOrder"] as const) {
      expect({ capability, officer: officer(capability) }).toEqual({ capability, officer: true });
    }
    for (const capability of ["approveQuote", "approveInvoice", "approveQuoteAsDirector", "approveInvoiceAsDirector", "manageQuotes", "rejectInvoice", "createPurchaseOrder", "sendPurchaseOrder", "recordPayment"] as const) {
      expect({ capability, officer: officer(capability) }).toEqual({ capability, officer: false });
    }
  });
});

// Every job action's gate reads the table: a new handler in these files that
// writes its own list fails here. The exceptions are reads and syncs that are
// not job actions.
describe("job-action handlers read their gate from the table", () => {
  const FILES = ["jobs", "quotes", "invoices", "purchaseOrders", "payments", "jobRequestedContractors", "reopenJob"];
  const NOT_JOB_ACTIONS = new Set(["syncInvoices", "getApprovalLimits", "getJobRequestedContractors"]);

  it.each(FILES)("%s.ts", (file) => {
    const source = readFileSync(join(__dirname, "..", "functions", `${file}.ts`), "utf8");
    const own: string[] = [];
    const starts = [...source.matchAll(/(?:export\s+)?async\s+function\s+(\w+)\s*\(/g)];
    starts.forEach((match, index) => {
      const body = source.slice(match.index, starts[index + 1]?.index ?? source.length);
      const gate = body.match(/requireRole\(\s*request\s*,\s*([^)]*)\)/);
      if (gate && !gate[1].startsWith("ACTION_ROLES.") && !NOT_JOB_ACTIONS.has(match[1])) own.push(`${match[1]}: ${gate[1]}`);
    });
    expect(own).toEqual([]);
  });
});
