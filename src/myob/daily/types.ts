// What the daily "What Floorplan did in MYOB" email (plan M4, decision 13c)
// is built from: one business morning to the next, Darwin time.

/** A DecisionLedger row about a MYOB proposal, with the proposal it is about. */
export interface ProposalEvent {
  action: string;
  actorName: string;
  after: Record<string, unknown> | null;
  companyFileId: string;
  companyFileName: string | null;
  jobId: number | null;
  myobNumber: string | null;
  myobUrl: string | null;
  occurredAt: Date;
  operation: string;
  proposalId: number;
  proposedBy: string;
  reason: string | null;
  rendered: { amount?: string; document?: string; number?: string; supplier?: string };
  reviewedBy: string | null;
  ruleApplied: string | null;
}

/** One MYOB call's outcome row in MyobApiLog: answered (response) or refused/failed (error). */
export interface MyobCall {
  actorKind: string;
  actorName: string;
  errorMessage: string | null;
  httpStatus: number | null;
  method: string;
  occurredAt: Date;
  path: string;
  phase: "error" | "response";
  purpose: string;
}

/** A DecisionLedger row about what Floorplan may do in MYOB: a control, a file's mode, the link. */
export interface ControlEvent {
  action: "myob.control_change" | "myob.link";
  actorName: string;
  after: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  /** The company file it is about (from its subject: "{file}:{operation}" or the linked file). */
  companyFileId: string;
  occurredAt: Date;
  reason: string | null;
  ruleApplied: string | null;
  /** The part of the subject after the file: an operation, "*" (pause) or "entity" (mode). */
  scope: string | null;
}

export interface RegisteredFile {
  id: string;
  name: string | null;
}

export interface DailyFacts {
  calls: MyobCall[];
  /** Changes to Floorplan's MYOB controls, file modes and the link. */
  controls: ControlEvent[];
  events: ProposalEvent[];
  /** Set when the window was capped: the email couldn't be sent from this morning until the window's start. */
  gapSince?: Date | null;
  /** Company files the CFO registered (MyobCompanyFiles); nothing else is ever reported. */
  files: RegisteredFile[];
  since: Date;
  until: Date;
}

export interface DailyRecipient {
  email: string | null;
  name: string;
  userId: number;
}
