import { LEDGER_ACTIONS, LedgerValidationError } from "./index";
import { assertLedgerEntry } from "./validate";
import type { LedgerEntryInput } from "./types";

const user = { kind: "user" as const, name: "Sam Accounts", role: "accounts_manager", userId: 7 };

function entry(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    action: "schedule.manual_edit",
    actor: user,
    after: { ratePercent: 3 },
    before: { ratePercent: 2.5 },
    subject: { id: "step-1", type: "rate_step" },
    tenantId: 42,
    ...overrides,
  };
}

describe("assertLedgerEntry", () => {
  it("accepts a valid entry", () => {
    expect(() => assertLedgerEntry(entry())).not.toThrow();
  });

  it("refuses an unknown action", () => {
    expect(() => assertLedgerEntry(entry({ action: "nope" as never }))).toThrow(LedgerValidationError);
  });

  it("refuses a subject type the action doesn't cover", () => {
    expect(() => assertLedgerEntry(entry({ subject: { id: 1, type: "quote" } }))).toThrow(/does not apply/);
  });

  it("lets refusal codes apply to any subject", () => {
    expect(() => assertLedgerEntry(entry({ action: "denied", subject: { id: 9, type: "quote" } }))).not.toThrow();
  });

  it("needs a subject id", () => {
    expect(() => assertLedgerEntry(entry({ subject: { id: "", type: "rate_step" } }))).toThrow(/subject id/);
  });

  it("requires a non-blank reason when the action does", () => {
    const revoke = { action: "schedule.sign_off_revoke" as const, subject: { id: 42, type: "tenancy" as const } };
    expect(() => assertLedgerEntry(entry({ ...revoke, reason: "   " }))).toThrow(/reason is required/);
    expect(() => assertLedgerEntry(entry({ ...revoke, reason: "Expiry was wrong in Excel" }))).not.toThrow();
  });

  it("caps reason length", () => {
    expect(() => assertLedgerEntry(entry({ reason: "x".repeat(2001) }))).toThrow(/longer than/);
  });

  it("needs actor name and, for people, a role", () => {
    expect(() => assertLedgerEntry(entry({ actor: { ...user, name: " " } }))).toThrow(/name/);
    expect(() => assertLedgerEntry(entry({ actor: { ...user, role: "" } }))).toThrow(/role/);
    expect(() => assertLedgerEntry(entry({ actor: { kind: "system", name: "tenancyReviewScheduleTimer" } }))).not.toThrow();
  });

  it("refuses a non-finite financial impact", () => {
    expect(() => assertLedgerEntry(entry({ financialImpact: Number.NaN }))).toThrow(/finite/);
  });

  it("refuses snapshots that can't be stored", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertLedgerEntry(entry({ before: circular }))).toThrow(/JSON-serialisable/);
    expect(() => assertLedgerEntry(entry({ after: "x".repeat(70 * 1024) }))).toThrow(/exceeds/);
  });
});

describe("attribution (a decision resting on a named manager)", () => {
  const manager = { name: "Mo Manager", role: "facilities_manager", userId: 12 };
  const approve = {
    action: "quote.approve_attributed" as const,
    actor: { kind: "user" as const, name: "Fay Staff", role: "facilities", userId: 11 },
    subject: { id: 5, type: "quote" as const },
  };

  it("is registered: required for the attributed approval, a reasoned exception for the dispute", () => {
    expect(LEDGER_ACTIONS["quote.approve_attributed"]).toEqual({
      attributionRequired: true,
      exception: false,
      reasonRequired: false,
      subjects: ["quote"],
    });
    expect(LEDGER_ACTIONS["quote.attribution_disputed"]).toEqual({
      exception: true,
      reasonRequired: true,
      subjects: ["quote"],
    });
  });

  it("refuses an attributed approval that names nobody", () => {
    expect(() => assertLedgerEntry(entry(approve))).toThrow(/needs attributedTo/);
  });

  it("accepts an attributed approval that names the manager", () => {
    expect(() => assertLedgerEntry(entry({ ...approve, attributedTo: manager }))).not.toThrow();
  });

  it("needs a non-blank name and role", () => {
    expect(() => assertLedgerEntry(entry({ ...approve, attributedTo: { ...manager, name: "  " } }))).toThrow(/name/);
    expect(() => assertLedgerEntry(entry({ ...approve, attributedTo: { ...manager, role: "" } }))).toThrow(/role/);
  });

  it("must not be the actor", () => {
    expect(() => assertLedgerEntry(entry({ ...approve, attributedTo: { ...manager, userId: 11 } }))).toThrow(
      /can't be the person deciding/,
    );
  });

  it("can't be compared when either id is unknown, so those pass", () => {
    expect(() => assertLedgerEntry(entry({ ...approve, attributedTo: { ...manager, userId: null } }))).not.toThrow();
    const unknownActor = { ...approve.actor, userId: null };
    expect(() =>
      assertLedgerEntry(entry({ ...approve, actor: unknownActor, attributedTo: { ...manager, userId: 11 } })),
    ).not.toThrow();
  });

  it("may accompany an action that doesn't require it", () => {
    expect(() => assertLedgerEntry(entry({ attributedTo: manager }))).not.toThrow();
  });

  it("fits the columns", () => {
    expect(() => assertLedgerEntry(entry({ attributedTo: { ...manager, name: "x".repeat(201) } }))).toThrow(/longer than/);
    expect(() => assertLedgerEntry(entry({ attributedTo: { ...manager, role: "x".repeat(33) } }))).toThrow(/longer than/);
    expect(() => assertLedgerEntry(entry({ attributedTo: { ...manager, userId: 1.5 } }))).toThrow(/whole number/);
  });

  it("makes the dispute need a reason", () => {
    const dispute = { action: "quote.attribution_disputed" as const, subject: { id: 5, type: "quote" as const } };
    expect(() => assertLedgerEntry(entry(dispute))).toThrow(/reason is required/);
    expect(() => assertLedgerEntry(entry({ ...dispute, reason: "I did not agree to this" }))).not.toThrow();
  });
});

describe("entries must fit dbo.DecisionLedger", () => {
  it("refuses over-long identifiers instead of letting the INSERT truncate", () => {
    expect(() => assertLedgerEntry(entry({ subject: { id: "x".repeat(65), type: "rate_step" } }))).toThrow(/longer than 64/);
    expect(() => assertLedgerEntry(entry({ actor: { ...user, name: "x".repeat(201) } }))).toThrow(/longer than 200/);
    expect(() => assertLedgerEntry(entry({ actor: { ...user, role: "x".repeat(33) } }))).toThrow(/longer than 32/);
    expect(() => assertLedgerEntry(entry({ ruleApplied: "x".repeat(65) }))).toThrow(/longer than 64/);
  });

  it("wants whole-number scope ids", () => {
    expect(() => assertLedgerEntry(entry({ tenantId: 4.5 }))).toThrow(/whole number/);
    expect(() => assertLedgerEntry(entry({ jobId: 2 ** 31 }))).toThrow(/whole number/);
    expect(() => assertLedgerEntry(entry({ buildingId: null, jobId: 9, tenantId: 1 }))).not.toThrow();
  });

  it("keeps the dollar impact inside DECIMAL(14,2)", () => {
    expect(() => assertLedgerEntry(entry({ financialImpact: 1e12 }))).toThrow(/out of range/);
    expect(() => assertLedgerEntry(entry({ financialImpact: -999_999_999_999.99 }))).not.toThrow();
  });

  it("wants a GUID correlation id when one is supplied", () => {
    expect(() => assertLedgerEntry(entry({ correlationId: "run-42" }))).toThrow(/GUID/);
    expect(() => assertLedgerEntry(entry({ correlationId: "6f9619ff-8b86-d011-b42d-00c04fc964ff" }))).not.toThrow();
  });
});
