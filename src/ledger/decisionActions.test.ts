/// <reference types="jest" />
// The answers' block of the action registry (jobs plan A2): approve, deny, defer and
// revise a decision request, and the two ways a next step ends.
import { assertLedgerEntry, LEDGER_ACTIONS, LedgerValidationError, type LedgerEntryInput } from "./index";
import { historyReadRoles } from "./historyRoles";

const OUTCOMES = ["decision.approve", "decision.defer", "decision.deny", "decision.revise"] as const;
const STEPS = ["decision.next_step_done", "decision.next_step_replaced"] as const;
const A1 = ["decision.requested", "decision.withdrawn"] as const;

const paolo = { kind: "user", name: "Paolo Director", role: "director", userId: 5 } as const;
const entry = (action: LedgerEntryInput["action"], over: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  action,
  actor: paolo,
  jobId: 12,
  subject: { id: 12, type: "job" },
  ...over,
});

describe("the decision action codes", () => {
  it("are A1's two and A2's six, all about a job, and fit the ledger's column", () => {
    const all = Object.keys(LEDGER_ACTIONS).filter((code) => code.startsWith("decision."));
    expect(all.sort()).toEqual([...A1, ...OUTCOMES, ...STEPS].sort());
    for (const code of all) {
      expect((LEDGER_ACTIONS as Record<string, { subjects: unknown }>)[code].subjects).toEqual(["job"]);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it("asks every outcome for its rationale, as the reason, and shows none of them as an exception", () => {
    for (const code of OUTCOMES) expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: false, reasonRequired: true });
  });

  it("asks nothing of a step that ends: the note is optional", () => {
    for (const code of STEPS) expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: false, reasonRequired: false });
  });

  it.each(OUTCOMES)("refuses %s with no rationale, or a blank one, before anything is written", (code) => {
    expect(() => assertLedgerEntry(entry(code))).toThrow(LedgerValidationError);
    expect(() => assertLedgerEntry(entry(code, { reason: "   " }))).toThrow(/reason is required/);
    expect(() => assertLedgerEntry(entry(code, { reason: "x".repeat(2001) }))).toThrow(/longer than 2000/);
  });

  it.each(OUTCOMES)("records %s on a job with the rationale as the reason and the decision as the after snapshot", (code) => {
    const after = { decisionId: 3, nextStep: "Pay it", outcome: code.slice("decision.".length) };
    expect(() => assertLedgerEntry(entry(code, { after, reason: "The lighting was ordered twice" }))).not.toThrow();
  });

  it.each(STEPS)("records %s with or without a note", (code) => {
    expect(() => assertLedgerEntry(entry(code))).not.toThrow();
    expect(() => assertLedgerEntry(entry(code, { reason: "Paid on the 14th" }))).not.toThrow();
  });

  it.each([...OUTCOMES, ...STEPS])("refuses %s about something that isn't a job", (code) => {
    expect(() => assertLedgerEntry(entry(code, { reason: "x", subject: { id: 12, type: "quote" } }))).toThrow(/does not apply to a quote/);
  });

  it("is read in the job's Decision history by whoever may read the job", () => {
    expect(historyReadRoles("job")).toEqual(expect.arrayContaining(["accounts", "facilities", "accounts_manager", "director"]));
  });
});
