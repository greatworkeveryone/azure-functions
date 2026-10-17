// Which step of a job an escalation about it opens on (beta sprint J6). Pure, so
// the job adapter, the notifier and the morning digest agree. A policy left out
// opens the job on Detail, where its status, assignee and progress are.

import { jobPath, type JobLinkTarget } from "../jobLinks";
import { decisionOf, isDecisionPolicy, isNextStepPolicy, nextStepOf } from "./decisionRows";
import type { EscalationRow } from "./types";

const POLICY_STEPS: Readonly<Record<string, JobLinkTarget["step"]>> = {
  "job.invoice_waiting": "invoices",
  "job.quote_not_back": "quotes",
};

/** The step, and the decision request for a question or the next step it handed on. */
export function jobLinkTarget(row: Pick<EscalationRow, "context" | "policyKey"> | undefined): JobLinkTarget {
  if (!row) return {};
  const decision = decisionOf(row);
  if (decision) return { decisionRequestId: decision.requestId, step: "decision" };
  const next = nextStepOf(row);
  if (next) return { decisionRequestId: next.requestId, step: "decision" };
  if (isDecisionPolicy(row.policyKey) || isNextStepPolicy(row.policyKey)) return { step: "decision" };
  return { step: POLICY_STEPS[row.policyKey] ?? null };
}

/** "/jobs?jobId=12&step=invoices" for a job escalation. */
export function jobEscalationPath(subjectId: string, row?: Pick<EscalationRow, "context" | "policyKey">): string {
  return jobPath(subjectId, jobLinkTarget(row));
}
