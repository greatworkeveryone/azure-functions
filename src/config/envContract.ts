// The settings whose absence breaks or quietly switches off part of Floorplan
// (DL-12; eng-health §7.5 found 24 that degrade without an error). Opt-in
// switches whose absence is the safe state (MYOB_WRITES_ENABLED,
// CPI_SYNC_ENABLED, …) are deliberately not here. /api/health?deep=true lists
// every entry that is unset or blank; a missing requiredInProd entry makes the
// check not ok. Add a row when code starts depending on a new setting.

export interface EnvSetting {
  /** What stops working, in words an operator can act on. */
  effect: string;
  name: string;
  requiredInProd: boolean;
}

const required = (name: string, effect: string): EnvSetting => ({ effect, name, requiredInProd: true });
const optional = (name: string, effect: string): EnvSetting => ({ effect, name, requiredInProd: false });

export const ENV_CONTRACT: readonly EnvSetting[] = [
  required("AZURE_FUNCTIONS_ENVIRONMENT", "Not \"Production\": Sentry is off, the startup migration check is skipped and the dev role override is not refused."),
  required("SENTRY_DSN", "Backend errors and failed timers are not reported to Sentry."),
  required("SQL_SERVER", "No database connection: every request fails."),
  required("SQL_DATABASE", "No database connection: every request fails."),
  required("GRAPH_TENANT_ID", "Every sign-in is refused; Graph and SQL tokens cannot be obtained."),
  required("GRAPH_CLIENT_ID", "The service SQL connection and all Graph mail fail."),
  required("GRAPH_CLIENT_SECRET", "The service SQL connection and all Graph mail fail."),
  required("AzureWebJobsStorage", "File uploads and downloads fail; timers and queues cannot run."),
  required("GRAPH_SENDER_EMAIL", "Every outgoing email (POs, director approvals, notifications) fails."),
  required("ORG_EMAIL_DOMAINS", "No internal email counts as authenticated, so emailed decisions are refused."),
  required("APP_BASE_URL", "Director, escalation and digest emails go out without links to the job."),
  required("MYBUILDINGS_API_URL", "Building and work-request sync fail on first use."),
  required("MYBUILDINGS_BEARER_TOKEN", "Building and work-request sync fail on first use."),
  required("DIRECTOR_APPROVAL_THRESHOLD", "Director sign-off gate (expected 50000 once migration 121 is applied). Unset or invalid: the gate is derived from the highest non-director limit, which moves whenever a limit is edited on the Roles page."),
  optional("DIRECTOR_APPROVAL_EMAILS", "Fallback director list: used only when no active user has the director role."),
  optional("FACILITIES_MANAGER_EMAILS", "Fallback facilities-manager list for escalation emails."),
  optional("FEEDBACK_EMAIL_RECIPIENTS", "The in-app feedback form answers 500."),
  optional("GRAPH_MAILBOX_DEV", "Inbound email is not synced; parsing runs on what is already stored."),
  optional("GRAPH_NOTIFICATION_URL", "No Graph mail webhook: mail arrives only with the daily sync; renewGraphSubscription fails."),
  optional("GRAPH_SUBSCRIPTION_CLIENT_STATE", "Graph notifications cannot be verified and are dropped; renewGraphSubscription fails."),
  optional("TODDLER_URL", "AI email parsing is skipped."),
  optional("TODDLER_SERVICE_KEY", "AI parse calls are refused (401) and burn their retries."),
  optional("PLANNER_FACILITIES_GROUP_ID", "Facilities Planner sync is skipped; the staff list cannot load facilities staff."),
  optional("PLANNER_FACILITIES_PLAN_ID", "Facilities Planner tasks are not created or updated."),
  optional("PLANNER_ACCOUNTS_GROUP_ID", "Accounts Planner sync is skipped; the staff list cannot load accounts staff."),
  optional("PLANNER_ACCOUNTS_PLAN_ID", "Accounts Planner tasks are not created or updated."),
  optional("MYOB_CLIENT_ID", "MYOB cannot be linked or read."),
  optional("MYOB_CLIENT_SECRET", "MYOB cannot be linked or read."),
  optional("MYOB_REDIRECT_URI", "MYOB cannot be linked."),
  optional("MYOB_COMPANY_FILE_ID", "MYOB calls go to a malformed URL."),
  optional("WORDPRESS_API_URL", "Vacancies cannot be published or unpublished on the website."),
  optional("WORDPRESS_USERNAME", "Vacancies cannot be published or unpublished on the website."),
  optional("WORDPRESS_APP_PASSWORD", "Vacancies cannot be published or unpublished on the website."),
  optional("BUILD_SHA", "Health cannot say which commit is deployed."),
];

/** Contract entries that are unset or blank in `env`. */
export function missingSettings(env: Record<string, string | undefined>): EnvSetting[] {
  return ENV_CONTRACT.filter((setting) => !env[setting.name]?.trim());
}
