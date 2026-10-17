/// <reference types="jest" />
// The decision-request block of the action registry (jobs plan A1): asking for a
// decision on a job, and taking the question back.
import { assertLedgerEntry, LEDGER_ACTIONS, LedgerValidationError, type LedgerEntryInput } from "./index";
import { historyReadRoles } from "./historyRoles";

const CODES = ["decision.requested", "decision.withdrawn"] as const;

const alana = { kind: "user", name: "Alana Accounts", role: "accounts", userId: 7 } as const;
const entry = (action: LedgerEntryInput["action"], over: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  action,
  actor: alana,
  jobId: 12,
  subject: { id: 12, type: "job" },
  ...over,
});

describe("the decision request action codes", () => {
  it("has the two of A1, both about a job (the answers of A2 are in decisionActions.test.ts)", () => {
    for (const code of CODES) {
      expect(LEDGER_ACTIONS[code].subjects).toEqual(["job"]);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it("asks for a reason to take a question back, which shows as an exception; asking needs none", () => {
    expect(LEDGER_ACTIONS["decision.withdrawn"]).toMatchObject({ exception: true, reasonRequired: true });
    expect(LEDGER_ACTIONS["decision.requested"]).toMatchObject({ exception: false, reasonRequired: false });
  });

  it("records a request on a job, with the request as the after snapshot and no reason", () => {
    const request = { question: "Pay the superseded invoice?", requestId: 3, state: "pending", tier: "soon" };
    expect(() => assertLedgerEntry(entry("decision.requested", { after: request }))).not.toThrow();
  });

  it("refuses a withdrawal with no reason, or a blank one", () => {
    expect(() => assertLedgerEntry(entry("decision.withdrawn"))).toThrow(LedgerValidationError);
    expect(() => assertLedgerEntry(entry("decision.withdrawn", { reason: "  " }))).toThrow(/reason is required/);
    expect(() => assertLedgerEntry(entry("decision.withdrawn", { reason: "Raised on the wrong job" }))).not.toThrow();
  });

  it("refuses either about something that isn't a job", () => {
    for (const code of CODES) {
      expect(() => assertLedgerEntry(entry(code, { reason: "x", subject: { id: 12, type: "quote" } }))).toThrow(/does not apply to a quote/);
    }
  });

  it("is read in a job's Decision history by whoever may read the job", () => {
    expect(historyReadRoles("job")).toContain("accounts");
    expect(historyReadRoles("job")).toContain("facilities");
  });
});
