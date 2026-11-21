// One obligations model (audit 5.4): everything a person is waiting on, and everything waiting on them, as one
// list. Each source has one small adapter (sources/*.ts) with a loader (a fixed number of queries, whoever asks)
// and a pure derive step (what this viewer sees of the facts). Nothing here sends anything or changes any record.

import type { Connection } from "tedious";
import type { AuthorityFacts } from "../approvalAuthority";
import type { ReportingLink, StaffMember } from "../leavePolicy";
import type { DirectoryUser } from "../escalation/types";

/** decide: an approval or decision only they or their role can give. do: work that is theirs to carry out.
 *  waiting: things they asked for or sent on, with who has them. */
export type ObligationGroup = "decide" | "do" | "waiting";

export const OBLIGATION_GROUPS: readonly ObligationGroup[] = ["decide", "do", "waiting"];

export interface Obligation {
  /** Nothing the viewer cannot complete is ever in decide or do: it is left out, or sits in waiting. */
  canAct: boolean;
  /** When the sweep will next chase it, if it chases it at all (null: nothing is promised). */
  chasedNext: string | null;
  dueAt: string | null;
  from: string | null;
  group: ObligationGroup;
  /** Source and record, stable between calls: "quote:41". */
  id: string;
  kind: string;
  /** The page, at the control that completes it. A path inside the app. */
  link: string;
  money?: { amount: number | null; subject: "invoice" | "purchase_order" | "quote" };
  /** The place: a building, or null. */
  place: string | null;
  /** What it is: "Quote from Acme · Job #12 · Leaking roof". */
  subject: string;
  /** A job nobody owns, shown to everyone on that side who can pick it up. */
  team?: boolean;
  /** The one action that completes it, as a button: "Approve quote". For waiting rows, what is awaited. */
  verb: string;
  waitingSince: string | null;
  /** Waiting rows: who has it now. */
  with?: string | null;
}

/** An obligation before the per-record dedupe: `key` names the thing so two sources never count it twice. */
export interface Candidate extends Obligation {
  key: string;
}

export interface Viewer {
  email: string | null;
  name: string;
  oid: string | null;
  /** Lower-case role names. */
  roles: string[];
  userId: number | null;
}

/** What every adapter reads besides its own tables. Loaded once however many people are asked about. */
export interface ObligationContext {
  authority: AuthorityFacts;
  directory: DirectoryUser[];
  links: ReportingLink[];
  now: Date;
  staff: StaffMember[];
  /** Darwin date, YYYY-MM-DD. */
  today: string;
}

export interface SourceAdapter<F> {
  /** Derive what this viewer sees. Pure. */
  derive(facts: F, viewer: Viewer, ctx: ObligationContext): Candidate[];
  /** A fixed number of queries, never one per row. */
  load(connection: Connection, ctx: ObligationContext): Promise<F>;
  name: string;
}

export interface ObligationAnswer {
  chasing: boolean;
  generatedAt: string;
  items: Obligation[];
  /** Rows left out of `items` by the per-source cap, by group: "and N more". */
  more: Record<ObligationGroup, number>;
  /** Every row in each group, shown or not. decide + do is the number every count in the app reads. */
  totals: Record<ObligationGroup, number>;
  /** Sources that could not be read this time: the list is incomplete, never "nothing waiting". */
  unavailable: string[];
}

/** The most rows one source shows per group; the rest are counted, not listed. */
export const PER_SOURCE_CAP = 50;
