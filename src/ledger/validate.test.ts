import { Connection } from "tedious";
import { LedgerValidationError, record } from "./index";
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

describe("record (stub)", () => {
  const tx = {} as Connection;

  it("resolves for a valid entry", async () => {
    await expect(record(tx, entry())).resolves.toBeUndefined();
  });

  it("rejects an invalid entry so the caller's decision fails", async () => {
    await expect(record(tx, entry({ action: "occupancy.reassign", subject: { id: 3, type: "occupancy" } }))).rejects.toThrow(
      LedgerValidationError,
    );
  });
});
