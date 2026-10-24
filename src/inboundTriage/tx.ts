// Inbound email triage (EB3): one transaction around a unit of work that commits or rolls back whole.
// "No ledger row, no decision": the assignment, its log rows and its ledger row travel together.

import type { Connection } from "tedious";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";

/** Runs `work` in a transaction. Returning `null` from it rolls back (nothing to keep); anything thrown rolls back and rethrows. */
export async function withTransaction<T>(connection: Connection, work: () => Promise<T | null>): Promise<T | null> {
  await beginTransaction(connection);
  let result: T | null;
  try {
    result = await work();
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
  if (result === null) {
    await rollbackTransaction(connection).catch(() => undefined);
    return null;
  }
  try {
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
  return result;
}
