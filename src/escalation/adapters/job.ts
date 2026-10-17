// The job adapter (WP20): describes a job to the engine, says when a job's
// problem has cleared, links to /jobs?jobId=, and keeps Jobs.EscalatedAt in
// step for the dashboard. A next step (jobs plan A2, policy job.next_step) is not a
// rule over the job's own facts: it holds while the job is live and a decision on it
// has handed on a step that is not yet done.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { holidaysFromEnv } from "../businessTime";
import { DECISION_PENDING_POLICY, isNextStepPolicy, NEXT_STEP_POLICY } from "../decisionRows";
import { normaliseRole, ROLES } from "../roles";
import { jobConditionActive } from "./jobRules";
import { hasOpenNextStep, loadJobFacts } from "./jobFacts";
import type { EscalationAdapter } from "./registry";

// Who may see escalations about a job: whoever may read jobs (VIEW_JOBS_ROLES in
// functions/jobs.ts). The CFO reads jobs through requireRole's accounts
// inheritance, so it is listed here.
const JOB_VIEW_ROLES: ReadonlySet<string> = new Set([
  ROLES.accounts,
  ROLES.accountsManager,
  ROLES.admin,
  ROLES.cfo,
  ROLES.director,
  ROLES.facilities,
  ROLES.facilitiesManager,
]);

const SUMMARY_PARTS_MAX = 160;

export function jobLabel(job: { buildingName?: string | null; jobId: number; title: string }): string {
  const parts = [`Job #${job.jobId}`, job.title.trim(), job.buildingName?.trim()].filter((part): part is string => Boolean(part));
  return parts.join(" · ").slice(0, SUMMARY_PARTS_MAX);
}

export const jobAdapter: EscalationAdapter = {
  subjectType: "job",

  deepLink: (subjectId) => `/jobs?jobId=${encodeURIComponent(subjectId)}`,

  async isConditionActive(connection, ref, now) {
    const jobId = Number(ref.subjectId);
    if (!Number.isInteger(jobId)) return false;
    if (isNextStepPolicy(ref.policyKey)) return hasOpenNextStep(connection, jobId);
    const job = await loadJobFacts(connection, jobId);
    if (!job) return false;
    return jobConditionActive(ref.policyKey, job, { holidays: holidaysFromEnv(), now });
  },

  ledgerScope: (escalation) => {
    const jobId = Number(escalation.subjectId);
    return { jobId: Number.isInteger(jobId) ? jobId : null };
  },

  async loadSummary(connection, subjectId) {
    const jobId = Number(subjectId);
    if (!Number.isInteger(jobId) || jobId <= 0) return null;
    const job = await loadJobFacts(connection, jobId);
    if (!job) return null;
    return {
      buildingId: job.buildingId,
      context: {
        assignedTo: job.assignedTo,
        buildingName: job.buildingName,
        jobId: job.jobId,
        priority: job.priority,
        status: job.status,
        title: job.title,
      },
      summary: jobLabel(job),
    };
  },

  // The dashboard flag follows the escalations: set while any escalation on the
  // job is still waiting for someone to pick it up, clear once none is. Runs in
  // the engine's transaction, so the flag and the escalation change together.
  // A decision request that has only just been asked is not an escalation yet, so
  // it does not flag the job; once it has been moved up (it has a parent) it does.
  // The same goes for a next step that has only just been handed on.
  async onChange(connection, escalation) {
    const jobId = Number(escalation.subjectId);
    if (!Number.isInteger(jobId)) return;
    await executeQuery(
      connection,
      `UPDATE dbo.Jobs
       SET EscalatedAt = CASE
             WHEN EXISTS (SELECT 1 FROM dbo.Escalations e
                          WHERE e.SubjectType = 'job' AND e.SubjectId = @SubjectId AND e.Status = 'open'
                            AND (e.PolicyKey NOT IN (@DecisionPolicy, @NextStepPolicy) OR e.ParentEscalationId IS NOT NULL))
             THEN COALESCE(EscalatedAt, SYSUTCDATETIME())
             ELSE NULL
           END
       WHERE JobID = @JobID`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "SubjectId", type: TYPES.NVarChar, value: String(jobId) },
        { name: "DecisionPolicy", type: TYPES.NVarChar, value: DECISION_PENDING_POLICY },
        { name: "NextStepPolicy", type: TYPES.NVarChar, value: NEXT_STEP_POLICY },
      ],
    );
  },

  visibleTo: (viewer) => viewer.roles.some((role) => JOB_VIEW_ROLES.has(normaliseRole(role))),
};
