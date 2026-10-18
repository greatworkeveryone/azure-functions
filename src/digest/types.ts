// Shapes for the morning digest (N1). Pure types: every other file in this
// folder can import them freely.

import type { EscalationRow } from "../escalation/types";

/** An active AppUsers row with a role, as the digest sees it. */
export interface DigestUser {
  email: string | null;
  name: string;
  /** AppUsers.DigestOptOut: true means the person switched the digest off. */
  optedOut: boolean;
  /** Trimmed and lower-cased. */
  role: string;
  userId: number;
}

/** A quote or an incoming invoice that has not finished its approvals. */
export interface WaitingApproval {
  /** null when the amount is unknown; the approval rules then need a director. */
  amount: number | null;
  buildingId: number | null;
  buildingName: string | null;
  createdAt: Date;
  id: number;
  jobId: number;
  /** Jobs.Kind of the job it belongs to. */
  jobKind: string;
  jobTitle: string;
  /** Quotes.Status or JobInvoices.Status as stored. */
  status: string;
  subject: "invoice" | "quote";
}

/** A live job assigned to a person whose next-update date has come. */
export interface DueJob {
  assignedToUserId: number;
  buildingName: string | null;
  expectedProgressUpdate: Date;
  jobId: number;
  /** Jobs.Kind. */
  kind: string;
  title: string;
}

/** One key still out after its expected return, one row per key. */
export interface OverdueKey {
  batchId: number;
  buildingName: string | null;
  expectedReturnAt: Date;
  keyId: number;
  keyNumber: string;
}

/** Everything the digest reads, once per run. */
export interface DigestFacts {
  dueJobs: DueJob[];
  /** Open and acknowledged escalations. */
  escalations: EscalationRow[];
  overdueKeys: OverdueKey[];
  /** "<kind>:<id>" of every test record (D9): none may appear in a digest. */
  testKeys?: ReadonlySet<string>;
  users: DigestUser[];
  waitingApprovals: WaitingApproval[];
}

export type DigestItemKind = "escalation" | "approval" | "due" | "key";

/** One line of a person's digest. Never carries an amount. */
export interface DigestItem {
  /** Two items with the same key are the same thing; the better one is kept. */
  dedupeKey: string;
  kind: DigestItemKind;
  line: string;
  /** Smaller sorts first within a kind. */
  order: number;
  /** In-app path, relative: "/jobs?jobId=12". */
  path: string;
}
