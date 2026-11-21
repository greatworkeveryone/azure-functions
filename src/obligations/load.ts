// Loading: one pass over every source's own queries (a fixed number, however long the lists), shared by whoever is
// being asked about, so the inbox answers one person and the digest answers everybody from the same read. A source
// that cannot be read is reported, never turned into "nothing waiting".

import type { Connection } from "tedious";
import { loadApprovalFacts, darwinToday } from "../approvalAuthority-db";
import { listActiveUsers } from "../escalation/store";
import { loadPeople } from "../peopleWorkflow";
import { SOURCES } from "./sources";
import type { ObligationContext, SourceAdapter } from "./types";

export interface LoadedObligations {
  context: ObligationContext;
  sources: Array<{ adapter: SourceAdapter<unknown>; facts: unknown }>;
  unavailable: string[];
}

export async function loadObligations(connection: Connection, now: Date = new Date()): Promise<LoadedObligations> {
  const authority = await loadApprovalFacts(connection, null);
  const directory = await listActiveUsers(connection);
  const people = await loadPeople(connection).catch(() => ({ links: [], staff: [] }));
  const context: ObligationContext = { authority, directory, links: [...people.links], now, staff: [...people.staff], today: darwinToday(now) };
  const sources: LoadedObligations["sources"] = [];
  const unavailable: string[] = [];
  for (const adapter of SOURCES) {
    try {
      sources.push({ adapter, facts: await adapter.load(connection, context) });
    } catch {
      unavailable.push(adapter.name);
    }
  }
  return { context, sources, unavailable };
}
