// RP's own MYOB company file, named by MYOB_RP_COMPANY_FILE_ID (plan M5
// review). Connor sets it, never an agent, and never on Azure without his yes.
// Until D9's test-data check and the money gate cover MYOB, Floorplan sends
// only to the demonstration file: send.ts refuses this file outright and
// refuses every send while the variable is unset, because without it the
// demonstration file can't be told apart from RP's (fail closed). The lab's
// readiness check (lab/status.ts) uses the same reading. Both lift with the
// demonstration-only rule.

/** The configured id, trimmed and lower-cased; null when unset or blank. */
export function rpCompanyFileId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.MYOB_RP_COMPANY_FILE_ID?.trim().toLowerCase() || null;
}
