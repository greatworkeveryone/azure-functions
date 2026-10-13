import { randomUUID } from "crypto";
import { assertLedgerEntry } from "./validate";
import type { LedgerEntryInput, LedgerTx } from "./types";

export * from "./actions";
export type * from "./types";
export { assertLedgerEntry, LedgerValidationError } from "./validate";

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Records one decision inside the caller's open transaction (PLAN §3.12).
 *
 * STUB until WP19b lands: validates the entry and writes nothing. Packages
 * built against it must not merge before WP19b (PLAN §5), and their tests mock
 * this function (`jest.mock("../ledger")`) rather than asserting on storage,
 * so they keep passing when the real store replaces the stub.
 */
export async function record(tx: LedgerTx, entry: LedgerEntryInput): Promise<void> {
  assertLedgerEntry(entry);
  void tx;
}
