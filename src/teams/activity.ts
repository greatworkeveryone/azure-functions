// Teams activity-feed alerts (WP63): one Graph sendActivityNotification to one
// person, addressed by their Entra object id (AppUsers.EntraOid). Dark unless
// teamsMode() says otherwise. An alert is a pointer into Floorplan, never the
// place a decision is made: keep amounts, names and addresses out of its text.
//
// Every HTTP outcome comes back as a typed result, never a throw, so a caller can
// fall back to email. Only a test record (TestDataEgressError, D9), an unsafe
// route and a missing TEAMS_APP_ID throw, before anything leaves.

import { clearGraphTokenCache, getGraphToken } from "../graph";
import { assertMayLeave, type EgressSubject } from "../test-data";
import { teamsAppId, teamsMode, type TeamsMode } from "./config";
import { teamsTabLink } from "./deepLink";

export interface TeamsAlert {
  /** What the alert is about; a test record's is refused (D9). */
  egress: EgressSubject;
  /** Shown on lock screens and toasts. */
  previewText: string;
  /** In-app path the alert opens, e.g. "/jobs?jobId=12&step=quotes". */
  route: string;
  /** The activity feed line. */
  text: string;
}

export interface TeamsSendDeps {
  /** Drops the cached token before the one retry on 401/403. */
  clearToken?: () => void;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  getToken?: () => Promise<string>;
  log?: (message: string) => void;
}

export type TeamsSendResult =
  | { status: "skipped"; mode: TeamsMode }
  | { status: "dry_run"; mode: TeamsMode; webUrl: string }
  | { status: "sent"; mode: TeamsMode }
  /** 403: consent missing or the app isn't installed for this person. */
  | { status: "not_permitted"; mode: TeamsMode; httpStatus: number; error: string }
  /** 404: no such user in the tenant. */
  | { status: "no_user"; mode: TeamsMode; httpStatus: number; error: string }
  /** 409: two Teams apps on one app registration. */
  | { status: "duplicate_app"; mode: TeamsMode; httpStatus: number; error: string }
  /** 429, 5xx or a network failure. A 5xx may have landed, so a retry can duplicate. */
  | { status: "retry"; mode: TeamsMode; httpStatus: number | null; retryAfterSeconds: number | null; error: string }
  | { status: "failed"; mode: TeamsMode; httpStatus: number | null; error: string };

const GRAPH_USERS = "https://graph.microsoft.com/v1.0/users";
const ERROR_TEXT_MAX = 500;

/** Retry-After as whole seconds (delta-seconds or an HTTP date), or null. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null || header.trim() === "") return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  // An HTTP date names its day and month; Date.parse alone would read "-5" as a year.
  const at = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

export function activityBody(alert: TeamsAlert, webUrl: string): Record<string, unknown> {
  return {
    activityType: "systemDefault",
    previewText: { content: alert.previewText },
    templateParameters: [{ name: "systemDefaultText", value: alert.text }],
    topic: { source: "text", value: "Floorplan", webUrl },
  };
}

// A result's status is a word, a Response's a number (tests pass plain objects, so not instanceof).
const isResponse = (value: Response | TeamsSendResult): value is Response => typeof value.status === "number";

const errorText = async (resp: Response): Promise<string> => (await resp.text().catch(() => "")).slice(0, ERROR_TEXT_MAX);

export async function sendActivityNotification(oid: string, alert: TeamsAlert, deps: TeamsSendDeps = {}): Promise<TeamsSendResult> {
  assertMayLeave("teams", alert.egress);
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const mode = teamsMode(env);
  if (mode === "off") return { mode, status: "skipped" };

  const appId = teamsAppId(env);
  if (appId === null) throw new Error("TEAMS_APP_ID not configured");
  const webUrl = teamsTabLink(appId, alert.route);
  if (mode === "dry-run") {
    log(`teams dry-run: would alert ${oid} -> ${alert.route}: ${alert.previewText}`);
    return { mode, status: "dry_run", webUrl };
  }

  const getToken = deps.getToken ?? getGraphToken;
  const post = async (): Promise<Response | TeamsSendResult> => {
    let token: string;
    try {
      token = await getToken();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), httpStatus: null, mode, status: "failed" };
    }
    try {
      return await (deps.fetch ?? fetch)(`${GRAPH_USERS}/${encodeURIComponent(oid)}/teamwork/sendActivityNotification`, {
        body: JSON.stringify(activityBody(alert, webUrl)),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        method: "POST",
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), httpStatus: null, mode, retryAfterSeconds: null, status: "retry" };
    }
  };

  let resp = await post();
  // App permissions are baked into the token at issue: after a new consent a cached
  // token still lacks TeamsActivity.Send. Refetch and try once; Graph refused the
  // first call, so this can't duplicate an alert. Never on 5xx or a network error.
  if (isResponse(resp) && (resp.status === 401 || resp.status === 403)) {
    (deps.clearToken ?? clearGraphTokenCache)();
    resp = await post();
  }
  if (!isResponse(resp)) return resp;

  const httpStatus = resp.status;
  // Graph answers 204; any 2xx means it was accepted.
  if (resp.ok) return { mode, status: "sent" };
  const error = await errorText(resp);
  if (httpStatus === 403) return { error, httpStatus, mode, status: "not_permitted" };
  if (httpStatus === 404) return { error, httpStatus, mode, status: "no_user" };
  if (httpStatus === 409) return { error, httpStatus, mode, status: "duplicate_app" };
  if (httpStatus === 429 || httpStatus >= 500) {
    return { error, httpStatus, mode, retryAfterSeconds: parseRetryAfter(resp.headers.get("Retry-After")), status: "retry" };
  }
  return { error, httpStatus, mode, status: "failed" };
}
