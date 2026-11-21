import { describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { presentNextAction, type StepViewer } from "../jobStepPresent";
import { JOB_STEP_LABELS, resolveJobStep } from "../jobStepResolver";
import type { NextAction, StepFacts } from "../jobStepTypes";

// This repo's paths, and the role table it exports to the frontend.
const SHARED_FILES: Record<string, string> = {
  "jobStepPresent.ts": join(__dirname, "../jobStepPresent.ts"),
  "jobStepResolver.ts": join(__dirname, "../jobStepResolver.ts"),
  "jobStepResolver.vectors.json": join(__dirname, "fixtures/jobStepResolver.vectors.json"),
  "jobStepTypes.ts": join(__dirname, "../jobStepTypes.ts"),
};
const VECTORS_PATH = SHARED_FILES["jobStepResolver.vectors.json"];
const ROLE_TABLE: Record<string, string[]> = JSON.parse(readFileSync(join(__dirname, "../../exports/action-roles.json"), "utf8"));
const holdsCapability = (role: string, capability: string): boolean => (ROLE_TABLE[capability] ?? []).includes(role);
const knownCapability = (capability: string): boolean => capability in ROLE_TABLE;

// ═══ Shared tests ════════════════════════════════════════════════════════════
// Identical in rpcc-functions src/__tests__/jobStepResolver.test.ts and in command-centre
// src/helpers/jobStepResolver.test.ts (everything below this line). Copy it across whole whenever either side changes,
// together with the four modules and the vectors. The matrix (status x role x facts) is the vector file: it is the
// jobs-flow audit's table (section C) written as data, one row per state, one cell per role.

/** SHA-256 of each shared file, the same in both repos. */
const PINS: Record<string, string> = {
  "jobStepPresent.ts": "b1f80d5a80f5a140d0bd2f2004a75881a9bc1b6e1650432db0cd0029dd13e601",
  "jobStepResolver.ts": "29f936bd115425069f85b6d67d281d98f57fa18a0414a33d784ec46ddefd2848",
  "jobStepTypes.ts": "f3da74469efe7a4d7472b33bb26700167b1f7e1a68c9bef6b7d19d31e9910621",
  "jobStepResolver.vectors.json": "53421e79f1d6d6e4d11111e8f7b28cf7dadc22b90f03a6e6e16b88c4dab271bd",
};

interface Expect {
  action: string | null;
  capability: string | null;
  jumpTarget: string | null;
  step: string;
  unassigned: boolean;
  verb: string;
  waitingOnUserId: number | null;
  who: string;
}
interface VectorCase {
  expect: Expect;
  facts: Record<string, unknown>;
  finding: string;
  name: string;
  viewers: string[];
}
interface Vectors {
  base: StepFacts;
  cases: VectorCase[];
  roles: string[];
  viewerCodes: string[];
}
const VECTORS: Vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
const USER_IDS = [1, 2, 3, 4, 5, 6, 7];

function factsOf(patch: Record<string, unknown>): StepFacts {
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(VECTORS.base));
  for (const [key, value] of Object.entries(patch)) {
    const section = merged[key];
    const isSection = value !== null && typeof value === "object" && section !== null && typeof section === "object" && key !== "assignee";
    merged[key] = isSection ? { ...(section as object), ...(value as object) } : value;
  }
  return merged as unknown as StepFacts;
}

function viewerOf(index: number): StepViewer {
  const role = VECTORS.roles[index];
  return { can: (capability) => holdsCapability(role, capability), name: VECTORS.viewerCodes[index], oid: `oid-${VECTORS.viewerCodes[index]}`, userId: USER_IDS[index] };
}

/** "+Label|you": + the contained button, ~ an outlined one, . a plain wait; |you when "Waiting on you" is true. */
function seen(next: NextAction, index: number): string {
  const view = presentNextAction(next, viewerOf(index));
  return `${view.isPassive ? "." : view.emphasis === "primary" ? "+" : "~"}${view.label}${view.onViewer ? "|you" : ""}`;
}

describe("job step resolver: shared vectors", () => {
  it("is byte-identical to its twin in the other repo (pinned SHA-256 of each module and the vectors)", () => {
    for (const [file, pin] of Object.entries(PINS)) {
      const path = SHARED_FILES[file];
      expect({ file, sha: createHash("sha256").update(readFileSync(path)).digest("hex") }).toEqual({ file, sha: pin });
    }
  });

  it("keeps the modules pure: only type and sibling imports, no clock, environment or console", () => {
    for (const file of ["jobStepPresent.ts", "jobStepResolver.ts", "jobStepTypes.ts"]) {
      const source = readFileSync(SHARED_FILES[file], "utf8");
      const imports = source.match(/^\s*import\s[^;]*;/gm) ?? [];
      for (const line of imports) expect(line).toMatch(/from "\.\/jobStep(Types|Resolver|Present)"/);
      expect(source).not.toMatch(/\brequire\(|\bDate\b|process\.|console\.|Math\.random|fetch\(/);
    }
  });

  it("treats a capability every job role holds as a team wait: nobody is told 'Waiting on you' for it", () => {
    for (const capability of ["createInvoice", "createQuote", "editJobs"]) {
      for (const role of VECTORS.roles) expect({ capability, role, holds: holdsCapability(role, capability) }).toEqual({ capability, holds: true, role });
    }
    const team = resolveJobStep(factsOf({ awaitingRole: "accounts", kind: "contract", status: "Awaiting Approval" })).nextAction;
    expect(team.who).toBe("Accounts");
    for (let index = 0; index < VECTORS.roles.length; index += 1) expect(presentNextAction(team, viewerOf(index)).waitLine).toBe("Waiting on Accounts");
  });

  it("covers every step, on hold and closed, in the matrix", () => {
    const steps = new Set(VECTORS.cases.map((row) => row.expect.step));
    for (const key of Object.keys(JOB_STEP_LABELS)) expect(steps).toContain(key);
  });

  it("uses only capabilities the role table knows", () => {
    for (const row of VECTORS.cases) {
      if (row.expect.capability) expect(knownCapability(row.expect.capability)).toBe(true);
    }
  });

  describe.each(VECTORS.cases.map((row) => [`${row.name}${row.finding ? ` [${row.finding}]` : ""}`, row] as const))("%s", (_title, row) => {
    const { nextAction, step } = resolveJobStep(factsOf(row.facts));

    it("resolves to the step and next action", () => {
      expect({
        action: nextAction.action,
        capability: nextAction.capability,
        jumpTarget: nextAction.jumpTarget,
        step: step.key,
        unassigned: nextAction.unassigned,
        verb: nextAction.verb,
        waitingOnUserId: nextAction.waitingOnUserId,
        who: nextAction.who,
      }).toEqual(row.expect);
      expect(step.label).toBe(JOB_STEP_LABELS[step.key]);
    });

    it("shows each role what the matrix says", () => {
      expect(VECTORS.roles.map((_role, index) => seen(nextAction, index))).toEqual(row.viewers);
    });
  });

  it("never leaves a live job with nobody offered an action", () => {
    for (const row of VECTORS.cases) {
      if (row.expect.step === "closed") continue;
      const { nextAction } = resolveJobStep(factsOf(row.facts));
      const offered = VECTORS.roles.filter((_role, index) => !presentNextAction(nextAction, viewerOf(index)).isPassive);
      expect({ name: row.name, offered: offered.length > 0 }).toEqual({ name: row.name, offered: true });
    }
  });

  it("never prints Awaiting approval, and never offers a disabled control", () => {
    for (const row of VECTORS.cases) {
      const { nextAction, step } = resolveJobStep(factsOf(row.facts));
      const words = [step.label, nextAction.verb, nextAction.who, nextAction.reason, nextAction.task, nextAction.escalation?.verb ?? "", nextAction.escalation?.reason ?? ""];
      for (let index = 0; index < VECTORS.roles.length; index += 1) {
        const view = presentNextAction(nextAction, viewerOf(index));
        words.push(view.label, view.detail, view.waitLine);
        expect(Object.keys(view)).not.toContain("disabledReason");
      }
      for (const word of words) expect(word.toLowerCase()).not.toContain("awaiting approval");
    }
  });

  it("says Waiting on you only to the assignee or a named or role-level approver, and names the team when nobody owns the job", () => {
    const unowned = resolveJobStep(factsOf({ status: "New" })).nextAction;
    const owned = resolveJobStep(factsOf({ assignee: { name: "Terry Other", userId: 99 }, status: "New" })).nextAction;
    const mine = resolveJobStep(factsOf({ assignee: { name: "Fran Officer", userId: 1 }, status: "New" })).nextAction;
    expect(presentNextAction(unowned, viewerOf(5)).waitLine).toBe("Waiting on Facilities · unassigned");
    expect(presentNextAction(unowned, viewerOf(5)).onViewer).toBe(false);
    expect(presentNextAction(owned, viewerOf(5)).waitLine).toBe("Waiting on Terry Other");
    expect(presentNextAction(mine, viewerOf(0)).waitLine).toBe("Waiting on you");
    expect(presentNextAction(mine, viewerOf(5)).waitLine).toBe("Waiting on Fran Officer");
  });

  it("matches an assignee with no user id on record by name", () => {
    const next = resolveJobStep(factsOf({ assignee: { name: "F", userId: null }, status: "New" })).nextAction;
    expect(presentNextAction(next, viewerOf(0)).onViewer).toBe(true);
    expect(presentNextAction(next, viewerOf(1)).onViewer).toBe(false);
  });

  describe("over the whole fact space", () => {
    const statuses = ["New", "Quote", "Awaiting Approval", "Work", "Tenant", "Done"] as const;
    const sides = ["facilities", "accounts"] as const;
    const kinds = ["standard", "contract", "internal"] as const;
    const quoteStates = [{}, { contractorsRequested: 2 }, { contractorsRequested: 2, requestsSent: 2 }, { declined: 1 }, { pending: 1 }, { pending: 1, pendingNeedsDirector: true }, { awaitingApproval: 1 }, { awaitingDirector: 1 }, { approved: true }];
    const poStates = [{}, { raised: 1, notInMyob: 1 }, { raised: 1, complete: 1, notInMyob: 1 }, { raised: 1, complete: 1 }];
    const invoiceStates = [{}, { rejected: 1 }, { incoming: 1, pending: 1 }, { incoming: 1, awaitingDirector: 1 }, { incoming: 1, approvedNotInMyob: 1 }, { incoming: 1 }];
    const space: StepFacts[] = [];
    for (const status of statuses) for (const awaitingRole of sides) for (const kind of kinds) for (const quotes of quoteStates) for (const purchaseOrders of poStates) for (const invoices of invoiceStates) {
      space.push(factsOf({ awaitingRole, invoices, kind, purchaseOrders, quotes, status }));
    }

    it("always answers, with the step the status demands and a real capability", () => {
      for (const facts of space) {
        const { nextAction, step } = resolveJobStep(facts);
        if (facts.status === "Done") expect(step.key).toBe("closed");
        if (facts.status === "Tenant") expect(step.key).toBe("on_hold");
        if (facts.status !== "Done" && facts.status !== "Tenant") expect(["closed", "on_hold"]).not.toContain(step.key);
        expect(step.number === null).toBe(step.key === "on_hold");
        if (nextAction.capability) expect(knownCapability(nextAction.capability)).toBe(true);
        for (let index = 0; index < VECTORS.roles.length; index += 1) {
          const view = presentNextAction(nextAction, viewerOf(index));
          expect(view.label.length).toBeGreaterThan(0);
          if (view.isPassive) expect(view.label).toMatch(/^Waiting on /);
        }
      }
    });

    it("gives an internal job no quote, purchase order or invoice step", () => {
      for (const facts of space.filter((row) => row.kind === "internal" && row.status !== "Done" && row.status !== "Tenant")) {
        expect(resolveJobStep(facts).step.key).toBe("work_under_way");
      }
    });
  });
});
