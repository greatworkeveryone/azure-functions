// The adapter registry (PLAN §3.7): the engine never knows what a job, a quote
// or a rent review is. Each subject type registers an adapter that says how to
// describe it, whether the problem still exists, where to send a person who
// wants to act, and who may see escalations about it. Other packages register
// theirs at module load:
//
//   import { registerAdapter } from "../escalation/adapters/registry";
//   registerAdapter({ subjectType: "quote", ... });
//
// An escalation never decides anything for its subject. Authority escalations
// end through the domain's own decision, so only attention escalations are
// ever asked whether their condition still holds.

import type { Connection } from "tedious";
import { EscalationError } from "../errors";
import type { EscalationRow, Viewer } from "../types";

/** What an adapter knows about a subject when it is escalated. */
export interface SubjectSummary {
  buildingId: number | null;
  /** Small JSON for the inbox row (title, status, names). Stored as Context. */
  context: Record<string, unknown>;
  /** One line naming the subject, e.g. "Job #12 · Leaking roof · Tower A". */
  summary: string;
}

/** Enough of an escalation to ask whether its problem still exists. */
export type ConditionRef = Pick<EscalationRow, "policyKey" | "subjectId" | "subjectType">;

export interface EscalationAdapter {
  /** The in-app path that opens the subject, e.g. "/jobs?jobId=12". Relative. */
  deepLink(subjectId: string): string;
  /** Attention escalations only: does the problem still exist? The sweep ends
   *  the escalation (condition_cleared) when this turns false. */
  isConditionActive(connection: Connection, ref: ConditionRef, now: Date): Promise<boolean>;
  /** Scope columns for the ledger rows of this escalation. */
  ledgerScope?(escalation: Pick<EscalationRow, "context" | "subjectId">): { jobId?: number | null; tenantId?: number | null };
  /** Null when the subject doesn't exist. */
  loadSummary(connection: Connection, subjectId: string): Promise<SubjectSummary | null>;
  /** Runs inside the engine's transaction after an escalation row changes, to
   *  keep the subject's own flags in step (Jobs.EscalatedAt). */
  onChange?(connection: Connection, escalation: EscalationRow): Promise<void>;
  subjectType: string;
  /** Narrows who may see escalations about this subject, on top of the target /
   *  raiser / roles-above rule, and who may raise one by hand. */
  visibleTo(viewer: Viewer, ref: ConditionRef): boolean;
  /** False for an escalation only its subject's own decision may end: nobody
   *  withdraws it by hand, its raiser and admin included. Left out: the usual
   *  rule (the raiser, or admin). */
  withdrawable?(escalation: Pick<EscalationRow, "kind" | "policyKey">): boolean;
}

const adapters = new Map<string, EscalationAdapter>();

export function registerAdapter(adapter: EscalationAdapter): void {
  adapters.set(adapter.subjectType, adapter);
}

export function getAdapter(subjectType: string): EscalationAdapter | null {
  return adapters.get(subjectType) ?? null;
}

export function requireAdapter(subjectType: string): EscalationAdapter {
  const adapter = adapters.get(subjectType);
  if (!adapter) {
    throw new EscalationError("unknown_subject_type", `Escalations about "${subjectType}" aren't available yet`);
  }
  return adapter;
}

export function registeredSubjectTypes(): string[] {
  return [...adapters.keys()].sort();
}

/** Test seam: drop one adapter. */
export function unregisterAdapter(subjectType: string): void {
  adapters.delete(subjectType);
}
