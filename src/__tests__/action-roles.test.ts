/// <reference types="jest" />
// The who-can-do-what table (beta sprint J4) and its export. The JSON the
// frontend reads must be this table, byte for byte: its SHA-256 is pinned here
// and in the frontend's src/constants/actionRoles.test.ts, so changing the
// table fails both until the file is re-exported, copied and re-pinned.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { ACTION_ROLES, admittedBy, exportActionRoles, rolesFor, type ActionRoles } from "../action-roles";
import { AppRole } from "../auth";

export {};

const EXPORT = join(__dirname, "..", "..", "exports", "action-roles.json");
const PINNED_SHA256 = "d8b786dc765ce7426d1671c24cada4fd25a14a5eae785594a9215caa1d8fc390";
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
  // archiveJob's gate is editJobs; who may archive a job they didn't create is
  // archiveAnyJob's literal list, swept with a probe (action-roles.parity.test).
  const SHARED_ROUTES: Record<string, string[]> = { archiveJob: ["archiveAnyJob", "editJobs"] };

  it("lists each route under one capability only, but for a route whose inner check is a capability of its own", () => {
    const routes = entries.flatMap(([, entry]) => entry.routes);
    expect(routes.filter((route, index) => routes.indexOf(route) !== index && !SHARED_ROUTES[route])).toEqual([]);
    for (const [route, capabilities] of Object.entries(SHARED_ROUTES)) {
      expect(entries.filter(([, entry]) => entry.routes.includes(route)).map(([capability]) => capability).sort()).toEqual(capabilities);
    }
  });

  it("refuses, or admits on a condition, only roles its gate admits, and always says why", () => {
    for (const [capability, entry] of entries) {
      const admitted = admittedBy(entry);
      expect({ capability, stray: (entry.refused ?? []).filter((role) => !admitted.includes(role)) }).toEqual({ capability, stray: [] });
      expect({ capability, strayConditional: (entry.conditional ?? []).filter((role) => !admitted.includes(role)) }).toEqual({
        capability,
        strayConditional: [],
      });
      expect({ capability, why: entry.why.length > 10 }).toEqual({ capability, why: true });
    }
  });

  it("leaves conditional roles out of what is offered, while the gate still admits them (package 117's encoding)", () => {
    const entry: ActionRoles = {
      conditional: [AppRole.FACILITIES],
      gate: [AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL],
      refused: [AppRole.ADMIN],
      routes: [],
      why: "approve, facilities only by attribution",
    };
    expect(rolesFor(entry)).toEqual([AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL]);
    expect(admittedBy(entry)).toEqual([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
  });

  it("offers the attributed quote approval to the attributed roles alone, and not yet the plain one", () => {
    expect(rolesFor(ACTION_ROLES.approveQuoteAttributed)).toEqual([AppRole.FACILITIES]);
    expect(exportActionRoles().approveQuoteAttributed).toEqual(["facilities"]);
    expect(rolesFor(ACTION_ROLES.approveQuote)).not.toContain(AppRole.FACILITIES);
  });

  it("archives areas and bays at the tenancy desk, and hard-deletes none of them (D10, J4 review)", () => {
    // Archive is reversible, reasoned and ledgered, the normal path under rule 1, and the
    // Edit tenancy modal archives the areas it removes: whoever edits a tenancy archives.
    expect(Object.keys(ACTION_ROLES)).not.toContain("hardDeleteTenancyRows");
    expect(ACTION_ROLES.archiveTenancyParts.gate).toBe(ACTION_ROLES.editTenancy.gate);
    expect(rolesFor(ACTION_ROLES.archiveTenancyParts)).toEqual([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.CFO, AppRole.DIRECTOR].sort());
    expect([...ACTION_ROLES.archiveTenancyParts.routes].sort()).toEqual(["archiveCarpark", "archiveOccupancy", "unarchiveCarpark", "unarchiveOccupancy"]);
    expect([...ACTION_ROLES.deleteTenancyRegisterRows.routes].sort()).toEqual(["deleteRegisterTenant", "deleteTenant"]);
  });

  it("splits completing a next step from answering a decision (A2): anyone who can be asked completes their own, managers and above any", () => {
    expect([...ACTION_ROLES.completeNextStep.routes]).toEqual(["completeJobNextStep"]);
    expect([...ACTION_ROLES.respondToDecision.routes]).toEqual(["respondToJobDecision"]);
    expect(ACTION_ROLES.completeAnyNextStep.match).toBe("exact");
    expect(rolesFor(ACTION_ROLES.completeAnyNextStep)).not.toContain(AppRole.FACILITIES);
  });

  it("lets a director alone decide a schedule change, and the tenancy desk ask for and withdraw one (WP26c, J4b)", () => {
    expect(rolesFor(ACTION_ROLES.ratifyScheduleChange)).toEqual([AppRole.DIRECTOR]);
    expect(rolesFor(ACTION_ROLES.rejectScheduleChange)).toEqual([AppRole.DIRECTOR]);
    expect(ACTION_ROLES.ratifyScheduleChange.refused).toEqual([AppRole.ADMIN]);
    expect(rolesFor(ACTION_ROLES.requestScheduleChange)).toEqual([
      AppRole.ACCOUNTS,
      AppRole.ACCOUNTS_APPROVAL,
      AppRole.ADMIN,
      AppRole.CFO,
      AppRole.DIRECTOR,
    ]);
    expect([...ACTION_ROLES.requestScheduleChange.routes]).toEqual(["requestScheduleChange", "withdrawScheduleChange"]);
    expect(ACTION_ROLES.requestScheduleChange.why).toContain("requester's alone");
  });

  it("lets admin manage test data, and admin and directors create it (D9, J4c)", () => {
    expect(rolesFor(ACTION_ROLES.manageTestData)).toEqual([AppRole.ADMIN]);
    expect([...ACTION_ROLES.manageTestData.routes]).toEqual(["setTestFlag"]);
    expect(rolesFor(ACTION_ROLES.createTestData)).toEqual([AppRole.ADMIN, AppRole.DIRECTOR]);
    expect(ACTION_ROLES.createTestData.match).toBe("exact");
  });

  it("lets the CFO archive any job under Connor's decision 11", () => {
    expect(rolesFor(ACTION_ROLES.archiveAnyJob)).toEqual([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.CFO, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL].sort());
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
  const FILES = ["jobs", "quotes", "invoices", "purchaseOrders", "payments", "jobRequestedContractors", "reopenJob", "emails"];
  // Reads, syncs and the shared inbox's own housekeeping: not job actions.
  const NOT_JOB_ACTIONS = new Set([
    "syncInvoices",
    "getApprovalLimits",
    "getJobRequestedContractors",
    "getEmails",
    "getEmail",
    "getEmailThread",
    "ingestEmail",
    "archiveEmail",
    "flagEmailForReview",
    "sendEmailReply",
    "syncEmailsNow",
  ]);

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
