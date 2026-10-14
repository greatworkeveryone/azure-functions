import { describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AwaitingRole, JobEvent, JobStatus, nextState, resolveManualTarget } from "../jobStatusMachine";
import {
  flagChangeRefusal,
  guardTransition,
  isHoldOrResume,
  type GuardActor,
  type GuardFacts,
  type GuardRequest,
  type GuardState,
  type GuardStatus,
} from "../jobTransitionGuard";

// This repo's copies, and this repo's state machine behind two adapters.
const GUARD_PATH = join(__dirname, "../jobTransitionGuard.ts");
const VECTORS_PATH = join(__dirname, "fixtures/jobTransitionGuard.vectors.json");

function machineManual(from: GuardState, target: GuardStatus, opts: { isContract: boolean; isInternal: boolean; preBlock: GuardState | null }): GuardState | null {
  const state = { awaitingRole: from.awaitingRole as AwaitingRole, status: from.status as JobStatus };
  const preBlockState = opts.preBlock ? { awaitingRole: opts.preBlock.awaitingRole as AwaitingRole, status: opts.preBlock.status as JobStatus } : undefined;
  const landed = resolveManualTarget(state, target as JobStatus, { isContract: opts.isContract, isInternal: opts.isInternal, preBlockState });
  return landed ? { awaitingRole: landed.awaitingRole, status: landed.status } : null;
}

function machinePaid(from: GuardState): GuardState | null {
  const landed = nextState({ awaitingRole: from.awaitingRole as AwaitingRole, status: from.status as JobStatus }, JobEvent.INVOICE_PAID);
  return landed ? { awaitingRole: landed.awaitingRole, status: landed.status } : null;
}

// ═══ Shared guard tests ══════════════════════════════════════════════════════
// Identical in rpcc-functions src/__tests__/jobTransitionGuard.test.ts and in
// command-centre src/helpers/jobTransitionGuard.test.ts. Copy it across whole
// whenever either side changes, together with the guard and the vectors.

/** SHA-256 of jobTransitionGuard.ts and of the vector file, the same in both repos. */
const GUARD_SHA256 = "e977d354d28ec4e125311a2359a47fa687350170af6e86ad69a55deb88555ba0";
const VECTORS_SHA256 = "d8295b4c6d8d73eb1df113b14b9dd6f869578728f9ea787ab645c11338168339";

interface Vectors {
  actorRoles: Record<string, string[] | "system">;
  actors: string[];
  codes: Record<string, string>;
  facts: Record<string, GuardFacts>;
  invoicesPaid: [string, string, string, string][];
  manual: [string, string, GuardStatus, string, string][];
  reopen: [string, string, string, string, string][];
  states: Record<string, { current: GuardState; preBlock: GuardState | null }>;
}
const VECTORS: Vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
const STATUSES: GuardStatus[] = ["New", "Quote", "Awaiting Approval", "Work", "Tenant", "Done"];

function actorOf(code: string): GuardActor {
  const roles = VECTORS.actorRoles[code];
  return roles === "system" ? { kind: "system" } : { kind: "user", roles };
}

function label(state: GuardState | null): string {
  return state ? `${state.status}/${state.awaitingRole}` : "-";
}

function decide(stateName: string, factsName: string, request: GuardRequest, actorCode: string) {
  const { current, preBlock } = VECTORS.states[stateName];
  const facts = VECTORS.facts[factsName];
  const machineTarget =
    request.kind === "manual"
      ? machineManual(current, request.target, { isContract: facts.isContract, isInternal: facts.isInternal, preBlock })
      : request.kind === "invoices_paid"
        ? machinePaid(current)
        : null;
  return { decision: guardTransition({ actor: actorOf(actorCode), current, facts, machineTarget, request }), machineTarget };
}

function encode(rows: { decision: ReturnType<typeof guardTransition> }[]): { outcomes: string; to: string } {
  const back = Object.fromEntries(Object.entries(VECTORS.codes).map(([short, long]) => [long, short]));
  const outcomes = rows.map(({ decision }) => (decision.allowed ? "+" : back[decision.code])).join(" ");
  const landed = rows.find(({ decision }) => decision.allowed)?.decision;
  return { outcomes, to: landed && landed.allowed ? label(landed.to) : "-" };
}

describe("job transition guard: shared vectors", () => {
  it("is byte-identical to its twin in the other repo, and so are the vectors (pinned SHA-256)", () => {
    expect(createHash("sha256").update(readFileSync(GUARD_PATH)).digest("hex")).toBe(GUARD_SHA256);
    expect(createHash("sha256").update(readFileSync(VECTORS_PATH)).digest("hex")).toBe(VECTORS_SHA256);
  });

  it("keeps the guard pure: no imports, clock, environment or console", () => {
    expect(readFileSync(GUARD_PATH, "utf8")).not.toMatch(/^\s*import\s|\brequire\(|\bDate\b|process\.|console\.|Math\.random/m);
  });

  it.each(VECTORS.manual)("manual: %s · %s · to %s", (state, facts, target, outcomes, landing) => {
    expect(encode(VECTORS.actors.map((actor) => decide(state, facts, { kind: "manual", target }, actor)))).toEqual({ outcomes, to: landing });
  });

  it.each(VECTORS.reopen)("reopen: %s · %s · reason %p", (state, facts, reason, outcomes, landing) => {
    expect(encode(VECTORS.actors.map((actor) => decide(state, facts, { kind: "reopen", reason }, actor)))).toEqual({ outcomes, to: landing });
  });

  it.each(VECTORS.invoicesPaid)("invoices paid: %s · %s", (state, facts, outcomes, landing) => {
    expect(encode(VECTORS.actors.map((actor) => decide(state, facts, { kind: "invoices_paid" }, actor)))).toEqual({ outcomes, to: landing });
  });

  // Properties over the whole space, whatever the table says.
  const space = Object.keys(VECTORS.states).flatMap((state) =>
    Object.keys(VECTORS.facts).flatMap((facts) =>
      VECTORS.actors.flatMap((actor) => STATUSES.map((target) => ({ actor, facts, state, target }))),
    ),
  );

  it("never lets a manual pick leave Done, start Work without an approved quote, or close without invoices", () => {
    for (const { actor, facts, state, target } of space) {
      const { decision, machineTarget } = decide(state, facts, { kind: "manual", target }, actor);
      if (!decision.allowed) continue;
      const jobFacts = VECTORS.facts[facts];
      expect(VECTORS.states[state].current.status).not.toBe("Done");
      expect(decision.to).toEqual(machineTarget);
      if (decision.to.status === "Work") expect(jobFacts.hasApprovedQuote || jobFacts.isContract || jobFacts.isInternal).toBe(true);
      if (decision.to.status === "Done" && !jobFacts.isInternal) {
        expect([jobFacts.incomingInvoices >= 1, jobFacts.incomingInvoicesAwaitingApproval, jobFacts.approvedInvoicesNotInMyob]).toEqual([true, 0, 0]);
      }
      expect(["U", "SYS"]).not.toContain(actor);
    }
  });

  it("lets every job-edit role hold any live job, and nobody hold a done one", () => {
    for (const { actor, facts, state } of space) {
      const live = VECTORS.states[state].current.status !== "Done" && VECTORS.states[state].current.status !== "Tenant";
      const { decision } = decide(state, facts, { kind: "manual", target: "Tenant" }, actor);
      expect(decision.allowed).toBe(live && !["U", "SYS"].includes(actor));
    }
  });

  it("closes a job as paid only for the system, and reopens only for a manager with a reason", () => {
    for (const { actor, facts, state } of space) {
      if (decide(state, facts, { kind: "invoices_paid" }, actor).decision.allowed) expect(actor).toBe("SYS");
      const reopened = decide(state, facts, { kind: "reopen", reason: "Wrong invoice closed it" }, actor).decision;
      if (reopened.allowed) {
        expect(["FM", "AM", "CFO", "D"]).toContain(actor);
        expect(VECTORS.states[state].current.status).toBe("Done");
      }
      expect(decide(state, facts, { kind: "reopen", reason: "   " }, actor).decision.allowed).toBe(false);
    }
  });

  it("gives every refusal a sentence a person can act on", () => {
    const decision = decide("Awaiting Approval/facilities", "quoted", { kind: "manual", target: "Work" }, "FM").decision;
    expect(decision).toEqual({
      allowed: false,
      code: "quote_not_approved",
      reason: "Work starts once a quote is approved (or on a contract or internal job).",
    });
  });

  it("offers only hold and resume from the chip and the progress note", () => {
    const stateAt = (status: GuardStatus): GuardState => ({ awaitingRole: "facilities", status });
    expect(STATUSES.filter((target) => isHoldOrResume(stateAt("Awaiting Approval"), target))).toEqual(["Tenant"]);
    expect(STATUSES.filter((target) => isHoldOrResume(stateAt("Tenant"), target))).toEqual(["Work"]);
    expect(STATUSES.filter((target) => isHoldOrResume(stateAt("Done"), target))).toEqual([]);
  });

  it("lets only managers set contract or internal, and only before any money record exists", () => {
    const user = (role: string): GuardActor => ({ kind: "user", roles: [role] });
    expect(flagChangeRefusal({ actor: user("facilities"), hasMoneyRecords: false })?.code).toBe("role_not_permitted");
    expect(flagChangeRefusal({ actor: user("accounts"), hasMoneyRecords: false })?.code).toBe("role_not_permitted");
    expect(flagChangeRefusal({ actor: user("facilities_manager"), hasMoneyRecords: false })).toBeNull();
    expect(flagChangeRefusal({ actor: user("Director"), hasMoneyRecords: false })).toBeNull();
    expect(flagChangeRefusal({ actor: user("facilities_manager"), hasMoneyRecords: true })?.code).toBe("flag_frozen");
  });
});

// ═══ End of shared guard tests ═══════════════════════════════════════════════

describe("job transition guard: backend only", () => {
  it("speaks the backend machine's status and side names", () => {
    expect(Object.values(JobStatus).sort()).toEqual([...STATUSES].sort());
    expect(Object.values(AwaitingRole).sort()).toEqual(["accounts", "facilities"]);
  });
});
