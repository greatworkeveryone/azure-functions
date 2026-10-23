// The four job priorities. jobs.ts checks a job's Priority against this list, and so
// does the inspection raise for a suggested job's. Mirrors JOB_PRIORITY_OPTIONS in
// command-centre src/components/jobs/jobPriority.ts, highest first.

export const JOB_PRIORITIES = ["Critical", "High", "Normal", "Low"] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];
